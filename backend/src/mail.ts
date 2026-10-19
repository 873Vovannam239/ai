import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
const escapeHtml = (v:string) => String(v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
@Injectable()
export class MailService {
  private transporter() {
    const user=process.env.SMTP_USER?.trim(),pass=process.env.SMTP_PASS?.trim();
    if(!user||!pass)throw new ServiceUnavailableException('Chưa cấu hình Gmail SMTP.');
    const port=Number(process.env.SMTP_PORT||465);
    return nodemailer.createTransport({host:process.env.SMTP_HOST||'smtp.gmail.com',port,secure:port===465,auth:{user,pass},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
  }
  private notificationRecipient() {
    return process.env.RECRUITMENT_NOTIFY_EMAIL?.trim() || process.env.SMTP_USER?.trim() || '';
  }
  async sendCandidateStatusNotification(candidate:any) {
    const to=this.notificationRecipient();
    if(!to)throw new ServiceUnavailableException('Thiếu RECRUITMENT_NOTIFY_EMAIL hoặc SMTP_USER để nhận thông báo.');
    const result=await this.transporter().sendMail({
      from:process.env.SMTP_FROM?.trim()||process.env.SMTP_USER?.trim(),to,
      subject:`[TalentFlow] Kết quả AI: ${candidate.name} – ${candidate.job_title}`,
      text:`TalentFlow vừa cập nhật hồ sơ ứng viên.\n\nỨng viên: ${candidate.name}\nVị trí: ${candidate.job_title}\nTrạng thái: ${candidate.ai_status}\nĐiểm phù hợp AI: ${candidate.score ?? 'Chưa có'}/100\nTóm tắt: ${candidate.ai_summary || candidate.ai_error || 'Chưa có'}\n\nĐây là thông báo hỗ trợ tuyển dụng; quyết định tiếp theo cần do người tuyển dụng xem xét.`
    });
    return result.messageId;
  }
  async sendRecruitmentReport(report:any) {
    const to=this.notificationRecipient();
    if(!to)throw new ServiceUnavailableException('Thiếu RECRUITMENT_NOTIFY_EMAIL hoặc SMTP_USER để nhận báo cáo.');
    const result=await this.transporter().sendMail({
      from:process.env.SMTP_FROM?.trim()||process.env.SMTP_USER?.trim(),to,
      subject:'[TalentFlow] Báo cáo tuyển dụng định kỳ',
      text:`BÁO CÁO TALENTFLOW\n\nThời điểm: ${new Date().toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})}\nTin tuyển dụng đang mở: ${report.openJobs}\nTổng hồ sơ ứng viên: ${report.candidates}\nHồ sơ đã phân tích AI: ${report.analyzed}\nLịch phỏng vấn đã lên: ${report.interviews}\nThư mời đã gửi: ${report.emailsSent}\nLịch nhắc đã gửi: ${report.remindersSent}\n\nLưu ý: điểm AI chỉ là thông tin hỗ trợ, không thay thế đánh giá của người tuyển dụng.`
    });
    return result.messageId;
  }
  async sendAutomationAlert(data:any) {
    const to=this.notificationRecipient();
    if(!to)throw new ServiceUnavailableException('Thiếu địa chỉ nhận cảnh báo.');
    const result=await this.transporter().sendMail({
      from:process.env.SMTP_FROM?.trim()||process.env.SMTP_USER?.trim(),to,
      subject:`[TalentFlow][${String(data.severity||'error').toUpperCase()}] Lỗi workflow ${data.workflow||'n8n'}`,
      text:`Một workflow n8n gặp lỗi.\n\nWorkflow: ${data.workflow||'Không xác định'}\nExecution ID: ${data.executionId||'Không có'}\nMức độ: ${data.severity||'error'}\nLỗi: ${data.error||'Không có chi tiết'}\n\nKiểm tra Executions trong n8n để điều tra.`
    });
    return result.messageId;
  }
  async sendReminder(interview:any) {
    const user=process.env.SMTP_USER?.trim(),pass=process.env.SMTP_PASS?.trim();
    if(!user||!pass)throw new ServiceUnavailableException('Chưa cấu hình Gmail SMTP.');
    const port=Number(process.env.SMTP_PORT||465);
    const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST||'smtp.gmail.com',port,secure:port===465,auth:{user,pass},connectionTimeout:15000,socketTimeout:20000});
    const time=new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'full',timeStyle:'short'}).format(new Date(interview.starts_at));
    const content=`Chào ${interview.candidate_name},\n\nĐây là thư nhắc lịch phỏng vấn vị trí ${interview.job_title} vào ${time} (giờ Việt Nam).\n${interview.mode==='online'?('Link: '+(interview.meeting_link||'Xem thư mời gốc')):('Địa điểm: '+(interview.notes||'Theo thư mời gốc'))}\n\nNếu cần thay đổi lịch, vui lòng phản hồi thư mời gốc.\nBộ phận tuyển dụng`;
    const result=await transporter.sendMail({from:process.env.SMTP_FROM?.trim()||user,to:interview.candidate_email,subject:`Nhắc lịch phỏng vấn – ${interview.job_title}`,text:content});
    return result.messageId;
  }
  async sendInvite(interview:any) {
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.trim();
    if (!user || !pass) throw new ServiceUnavailableException('Chưa cấu hình SMTP_USER hoặc SMTP_PASS để gửi Gmail thật.');
    const transporter = nodemailer.createTransport({
      host:process.env.SMTP_HOST || 'smtp.gmail.com',
      port:Number(process.env.SMTP_PORT || 465), secure:Number(process.env.SMTP_PORT || 465)===465,
      auth:{user,pass}, connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000
    });
    const datetime = new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh', dateStyle:'full',timeStyle:'short'}).format(new Date(interview.starts_at));
    const mode = interview.mode==='online'?'Trực tuyến':'Trực tiếp';
    const info = interview.mode==='online' ? `Đường dẫn: ${interview.meeting_link || 'Sẽ gửi sau'}` : `Địa điểm/hướng dẫn: ${interview.notes || 'Sẽ thông báo sau'}`;
    const subject = `Thư mời phỏng vấn – ${interview.job_title}`;
    const text = `Chào ${interview.candidate_name},\n\nChúng tôi trân trọng mời bạn tham gia phỏng vấn cho vị trí ${interview.job_title}.\nThời gian: ${datetime} (giờ Việt Nam)\nThời lượng: ${interview.duration_minutes} phút\nHình thức: ${mode}\n${info}\n\nVui lòng phản hồi email này để xác nhận tham dự.\nTrân trọng,\nBộ phận tuyển dụng`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#223044"><h2>Thư mời phỏng vấn</h2><p>Chào <b>${escapeHtml(interview.candidate_name)}</b>,</p><p>Chúng tôi trân trọng mời bạn tham gia phỏng vấn cho vị trí <b>${escapeHtml(interview.job_title)}</b>.</p><ul><li><b>Thời gian:</b> ${escapeHtml(datetime)} (giờ Việt Nam)</li><li><b>Thời lượng:</b> ${interview.duration_minutes} phút</li><li><b>Hình thức:</b> ${escapeHtml(mode)}</li><li>${escapeHtml(info)}</li></ul><p>Vui lòng phản hồi email để xác nhận tham dự.</p><p>Trân trọng,<br/>Bộ phận tuyển dụng</p></div>`;
    const result = await transporter.sendMail({from:process.env.SMTP_FROM?.trim() || user, to:interview.candidate_email,subject,text,html});
    return result.messageId;
  }
}
