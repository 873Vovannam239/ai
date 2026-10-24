import { BadGatewayException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { DbService } from './db';
import { MailService } from './mail';

type MailKind = 'invite' | 'reminder';
type Outcome = {
  sent: boolean;
  alreadySent?: boolean;
  processing?: boolean;
  unknown?: boolean;
  skipped?: boolean;
  messageId?: string;
  aiAssisted?: boolean;
  error?: string;
};
const LEASE_MINUTES = 3;
const eligibility = (kind: MailKind) => kind === 'invite'
  ? "status='scheduled' AND starts_at>now() AND email_sent_at IS NULL"
  : "status='scheduled' AND email_status='sent' AND reminder_sent_at IS NULL AND starts_at>now()+interval '10 minutes' AND starts_at<=now()+interval '24 hours'";
const prefix = (kind: MailKind) => kind === 'invite' ? 'email' : 'reminder';
const message = (error: any) => String(error?.message || error || 'Gửi thư thất bại').slice(0, 350);

/** A preparation lease is retryable. Once SMTP starts, uncertain delivery needs reconciliation. */
export class InterviewDelivery {
  private readonly logger = new Logger(InterviewDelivery.name);
  constructor(private readonly db: DbService, private readonly mail: MailService) {}

  private async audit(workflow: string, id: string, success: boolean, detail: string) {
    // An audit outage must never turn a successfully sent email into a retryable failure.
    const results = await Promise.allSettled([
      this.db.event('email', detail, id),
      this.db.rows('INSERT INTO automation_runs(workflow,ref_id,status,detail) VALUES($1,$2,$3,$4)',
        [workflow, id, success ? 'success' : 'failed', detail.slice(0, 400)])
    ]);
    for (const result of results) if (result.status === 'rejected') this.logger.warn(message(result.reason));
  }

  async recoverStale(kind: MailKind, id?: string) {
    const p = prefix(kind);
    const rows = await this.db.rows(`UPDATE interviews SET
      ${p}_status=CASE WHEN ${p}_delivery_started_at IS NULL THEN 'failed' ELSE 'unknown' END,
      ${p}_error=CASE WHEN ${p}_delivery_started_at IS NULL
        THEN 'Tác vụ chuẩn bị thư bị gián đoạn; được phép thử lại.'
        ELSE 'SMTP đã bắt đầu nhưng chưa xác định kết quả. Đối soát thư đã gửi trước khi thử lại.' END
      WHERE ${p}_status='sending' AND ${p}_sent_at IS NULL
        AND (${p}_attempt_started_at IS NULL OR ${p}_attempt_started_at<=now()-interval '${LEASE_MINUTES} minutes')
        AND ($1::uuid IS NULL OR id=$1::uuid)
      RETURNING id,${p}_status AS state`, [id || null]);
    for (const row of rows) await this.audit(kind === 'invite' ? 'interview-invite' : 'recruitment-followup', row.id, false,
      row.state === 'unknown' ? 'Thư cần đối soát: tác vụ dừng sau khi bắt đầu SMTP.' : 'Đã phục hồi tác vụ dừng trước khi gửi SMTP.');
    return rows.filter(row => row.state === 'failed').length;
  }

  private async load(id: string) {
    return this.db.one(`SELECT i.*,c.name AS candidate_name,c.email AS candidate_email,j.title AS job_title
      FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=c.job_id WHERE i.id=$1`, [id]);
  }

  private observed(row: any, kind: MailKind): Outcome {
    const p = prefix(kind);
    if (row?.[`${p}_status`] === 'sent' || row?.[`${p}_sent_at`]) return {sent: true, alreadySent: true, messageId: row[`${p}_message_id`]};
    if (row?.[`${p}_status`] === 'unknown') return {sent: false, unknown: true, error: row[`${p}_error`]};
    if (row?.[`${p}_status`] === 'sending') return {sent: false, processing: true};
    return {sent: false, skipped: true};
  }

  private async deliver(kind: MailKind, id: string): Promise<Outcome> {
    const p = prefix(kind), workflow = kind === 'invite' ? 'interview-invite' : 'recruitment-followup';
    const current = await this.load(id);
    if (!current) throw new NotFoundException('Không tìm thấy lịch phỏng vấn.');
    const existing = this.observed(current, kind);
    if (existing.sent || existing.unknown || existing.processing) return existing;
    const attemptId = crypto.randomUUID();
    const claimed = await this.db.one(`UPDATE interviews SET ${p}_status='sending',${p}_attempt_started_at=now(),
      ${p}_attempt_id=$2,${p}_delivery_started_at=NULL,${p}_error=NULL,
      ${p}_message_id=COALESCE(${p}_message_id,$3)
      WHERE id=$1 AND ${p}_status IN ('pending','failed') AND ${eligibility(kind)} RETURNING *`,
      [id, attemptId, `<talentflow-${kind}-${id}@talentflow.invalid>`]);
    if (!claimed) return this.observed(await this.load(id), kind);
    let started = false;
    let delivery: {messageId: string; aiAssisted: boolean};
    try {
      const beforeSend = async () => {
        // Recheck eligibility and ownership immediately before SMTP, after any AI preparation.
        const active = await this.db.one(`UPDATE interviews SET ${p}_delivery_started_at=now()
          WHERE id=$1 AND ${p}_attempt_id=$2 AND ${p}_status='sending'
            AND ${p}_attempt_started_at>now()-interval '${LEASE_MINUTES} minutes'
            AND ${eligibility(kind)} RETURNING id`, [id, attemptId]);
        if (!active) throw Object.assign(new Error('Lịch không còn đủ điều kiện hoặc tác vụ đã được thay thế.'), {deliverySkipped: true});
        started = true;
      };
      const input = {...current, ...claimed};
      delivery = kind === 'invite'
        ? await this.mail.sendInvite(input, beforeSend)
        : await this.mail.sendReminder(input, beforeSend);
    } catch (error: any) {
      if (error?.deliverySkipped) {
        await this.db.rows(`UPDATE interviews SET ${p}_status='failed',${p}_error=$3
          WHERE id=$1 AND ${p}_attempt_id=$2 AND ${p}_status='sending' AND ${p}_delivery_started_at IS NULL`,
          [id, attemptId, message(error)]);
        return {sent: false, skipped: true};
      }
      // Socket timeouts/disconnects can happen after acceptance, even with command='CONN'.
      const rejected = (Number(error?.responseCode) >= 400 && Number(error?.responseCode) < 600)
        || ['EAUTH', 'EENVELOPE'].includes(error?.code);
      const uncertain = started && !rejected;
      const detail = uncertain ? `Chưa xác định kết quả SMTP; cần đối soát. ${message(error)}` : message(error);
      await this.db.rows(`UPDATE interviews SET ${p}_status=$3,${p}_error=$4
        WHERE id=$1 AND ${p}_attempt_id=$2 AND ${p}_status IN ('sending','unknown') AND ${p}_sent_at IS NULL`,
        [id, attemptId, uncertain ? 'unknown' : 'failed', detail]);
      await this.audit(workflow, id, false, detail);
      return {sent: false, unknown: uncertain, error: detail};
    }

    // SMTP succeeded. Persistence/audit failures below must never make it safe to resend.
    try {
      const saved = await this.db.one(`UPDATE interviews SET ${p}_status='sent',${p}_sent_at=now(),${p}_error=NULL,
        ${p}_message_id=$3 WHERE id=$1 AND ${p}_attempt_id=$2 AND ${p}_status IN ('sending','unknown') RETURNING id`,
        [id, attemptId, delivery.messageId]);
      if (!saved) return this.observed(await this.load(id), kind);
    } catch (error: any) {
      this.logger.error(`SMTP đã nhận thư ${id}, chưa lưu được trạng thái: ${message(error)}`);
      return {sent: false, unknown: true, messageId: delivery.messageId, error: 'SMTP đã nhận thư nhưng chưa lưu được xác nhận. Cần đối soát, không tự gửi lại.'};
    }
    await this.audit(workflow, id, true, `${kind === 'invite' ? 'Thư mời' : 'Thư nhắc lịch'} đã được SMTP chấp nhận${delivery.aiAssisted ? '; Groq hỗ trợ nội dung' : ''}.`);
    return {sent: true, messageId: delivery.messageId, aiAssisted: delivery.aiAssisted};
  }

  async sendInvite(id: string) {
    await this.recoverStale('invite', id);
    const result = await this.deliver('invite', id);
    if (result.unknown) throw new ConflictException({status: 'unknown', unknown: true, message: result.error || 'Cần đối soát thư đã gửi trước khi thử lại.'});
    if (result.error) throw new BadGatewayException(result.error);
    if (result.skipped) throw new ConflictException('Lịch đã hủy hoặc không còn ở tương lai.');
    return result;
  }

  async processReminders() {
    await this.recoverStale('invite');
    const recovered = await this.recoverStale('reminder');
    const due = await this.db.rows(`SELECT id FROM interviews WHERE ${eligibility('reminder')}
      AND reminder_status IN ('pending','failed','sending','unknown')
      ORDER BY CASE reminder_status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
        reminder_attempt_started_at NULLS FIRST,starts_at,id LIMIT 20`);
    let sent = 0, failed = 0, processing = 0, unknown = 0, skipped = 0, aiAssisted = 0;
    for (const item of due) {
      try {
        const result = await this.deliver('reminder', item.id);
        if (result.sent && !result.alreadySent) { sent++; if (result.aiAssisted) aiAssisted++; }
        else if (result.sent || result.skipped) skipped++;
        else if (result.unknown) unknown++;
        else if (result.processing) processing++;
        else failed++;
      } catch (error: any) {
        failed++;
        this.logger.error(`Không xử lý được thư nhắc ${item.id}: ${message(error)}`);
      }
    }
    const status = failed + unknown > 0 ? (sent > 0 ? 'partial' : 'failed') : processing > 0 ? 'partial' : 'success';
    await this.audit('recruitment-followup', 'scheduled', status === 'success',
      `Nhắc lịch: đã gửi ${sent}, lỗi ${failed}, đang xử lý ${processing}, cần đối soát ${unknown}, bỏ qua ${skipped}, phục hồi ${recovered}.`);
    return {due: due.length, sent, failed, processing, unknown, skipped, recovered, aiAssisted, status, window: '10 phút đến 24 giờ trước phỏng vấn'};
  }
}
