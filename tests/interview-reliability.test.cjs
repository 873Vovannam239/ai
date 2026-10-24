/*
 * Real PostgreSQL behavior tests; only SMTP and Groq are replaced.
 * Run from the repo root:
 * TEST_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/talentflow_test \
 *   node --test tests/interview-reliability.test.cjs
 *
 * No .env file is read. Only an explicitly named, local test database is accepted.
 * Each run migrates and drops its own random schema; existing schemas are untouched.
 */
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  test('interview reliability: requires an explicit isolated PostgreSQL test database', {
    skip: 'Set TEST_DATABASE_URL to a local database named talentflow_test or talentflow_test_<suffix>.',
  }, () => {});
} else {
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'TEST_DATABASE_URL must use PostgreSQL');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Tests only accept a local PostgreSQL server');
  assert.match(decodeURIComponent(url.pathname.slice(1)), /^talentflow_test(?:_[a-z0-9_]+)?$/i,
    'Refusing a database not explicitly named talentflow_test or talentflow_test_<suffix>');
  assert.equal(url.searchParams.has('options'), false, 'Pass a plain test URL without search_path/options overrides');

  const schema = `interview_test_${process.pid}_${randomBytes(5).toString('hex')}`;
  const temp = mkdtempSync(path.join(tmpdir(), 'talentflow-interview-tests-'));
  const originalFetch = global.fetch;
  const savedEnv = new Map(['DATABASE_URL', 'N8N_WEBHOOK_URL', 'AUTOMATION_PRO_ENABLED'].map(k => [k, process.env[k]]));
  let admin, db, service, mail, AppService;

  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function makeMail() {
    return {
      invites: [], reminders: [],
      async sendInvite(interview, beforeSend) {
        await beforeSend?.();
        this.invites.push(interview.id);
        return { messageId: `invite-${this.invites.length}`, aiAssisted: false };
      },
      async sendReminder(interview, beforeSend) {
        await beforeSend?.();
        this.reminders.push(interview.id);
        return { messageId: `reminder-${this.reminders.length}`, aiAssisted: true };
      },
    };
  }

  async function candidate({ ready = true } = {}) {
    const job = await db.one(`INSERT INTO jobs(title,description,requirements)
      VALUES('Test engineer','Build reliable workflows','SQL and workflow skills') RETURNING id`);
    return db.one(`INSERT INTO candidates(job_id,name,email,cv_filename,cv_text,ai_status)
      VALUES($1,'Test Candidate',$2,'test.txt','Synthetic test CV only',$3) RETURNING *`,
    [job.id, `test-${randomBytes(4).toString('hex')}@example.invalid`, ready ? 'ready' : 'pending']);
  }

  async function interview({ candidateId, minutesUntil = 120, emailStatus = 'sent',
    reminderStatus = 'pending', status = 'scheduled', alreadyReminded = false } = {}) {
    const c = candidateId ? { id: candidateId } : await candidate();
    return db.one(`INSERT INTO interviews(candidate_id,starts_at,duration_minutes,status,email_status,
      reminder_status,reminder_sent_at) VALUES($1,now()+$2*interval '1 minute',30,$3,$4,$5,
      CASE WHEN $6 THEN now() ELSE NULL END) RETURNING *`,
    [c.id, minutesUntil, status, emailStatus, reminderStatus, alreadyReminded]);
  }

  function schedulePayload(candidateId, startsAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString(), durationMinutes = 30) {
    return { candidateId, startsAt, durationMinutes, mode: 'online', meetingLink: 'https://example.invalid/interview' };
  }

  before(async () => {
    const compiled = spawnSync(path.join(root, 'backend/node_modules/.bin/tsc'),
      ['--project', path.join(root, 'backend/tsconfig.json'), '--outDir', temp], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, `Backend compilation failed:\n${compiled.stdout}\n${compiled.stderr}`);
    symlinkSync(path.join(root, 'backend/node_modules'), path.join(temp, 'node_modules'), 'dir');
    const backendRequire = createRequire(path.join(root, 'backend/package.json'));
    const { Pool } = backendRequire('pg');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    process.env.DATABASE_URL = url.toString();
    delete process.env.N8N_WEBHOOK_URL;
    process.env.AUTOMATION_PRO_ENABLED = 'false';
    global.fetch = async () => { throw new Error('Unexpected external HTTP call during interview tests'); };
    ({ AppService } = require(path.join(temp, 'service.js')));
    const { DbService } = require(path.join(temp, 'db.js'));
    db = new DbService();
    for (const file of ['001_schema.sql', '002_pro_upgrade.sql', '005_interview_reliability.sql']) {
      await db.rows(readFileSync(path.join(root, 'sql', file), 'utf8'));
    }
  });

  beforeEach(async () => {
    await db.rows('TRUNCATE jobs,events,automation_runs RESTART IDENTITY CASCADE');
    mail = makeMail();
    service = new AppService(db, { async generateInterviewGuide() { return []; } }, mail);
  });

  after(async () => {
    try { if (db) await db.onModuleDestroy(); }
    finally {
      if (admin) {
        try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
        finally { await admin.end(); }
      }
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      global.fetch = originalFetch;
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('concurrent overlapping requests create exactly one active interview', async () => {
    const c = await candidate();
    const payload = schedulePayload(c.id);
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      service.scheduleByWorkflow({ ...payload, startsAt: new Date(Date.parse(payload.startsAt) + index * 60_000).toISOString() })));
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    for (const outcome of outcomes.filter(x => x.status === 'rejected')) {
      assert.equal(outcome.reason.getStatus(), 409);
    }
    assert.equal((await db.one('SELECT count(*)::int AS count FROM interviews')).count, 1);
  });

  test('adjacent interviews, a different candidate, and a cancelled slot do not conflict', async () => {
    const c = await candidate();
    const first = schedulePayload(c.id);
    const created = await service.scheduleByWorkflow(first);
    await service.scheduleByWorkflow({ ...first, startsAt: new Date(Date.parse(first.startsAt) + 30 * 60_000).toISOString() });
    await service.scheduleByWorkflow({ ...first, candidateId: (await candidate()).id });
    await db.rows("UPDATE interviews SET status='cancelled' WHERE id=$1", [created.id]);
    await service.scheduleByWorkflow(first);
    assert.equal((await db.one('SELECT count(*)::int AS count FROM interviews')).count, 4);
  });

  test('the public scheduling path propagates workflow validation and duplicate conflicts', async () => {
    const c = await candidate();
    const payload = schedulePayload(c.id);
    const existing = await service.scheduleByWorkflow(payload);
    const previousFetch = global.fetch;
    process.env.AUTOMATION_PRO_ENABLED = 'true';
    try {
      for (const status of [400, 409]) {
        global.fetch = async () => new Response(JSON.stringify({ ok: false, error: `Synthetic scheduling ${status}` }), {
          status, headers: { 'content-type': 'application/json' },
        });
        await assert.rejects(service.schedule(payload), error => error.getStatus() === status);
      }
      assert.equal((await db.one('SELECT count(*)::int AS count FROM interviews')).count, 1);
      assert.equal((await db.one('SELECT id FROM interviews')).id, existing.id);
    } finally {
      global.fetch = previousFetch;
      process.env.AUTOMATION_PRO_ENABLED = 'false';
    }
  });

  test('the public fallback rebooks a cancelled slot when n8n is unavailable', async () => {
    const c = await candidate();
    const payload = schedulePayload(c.id);
    const old = await service.scheduleByWorkflow(payload);
    await db.rows("UPDATE interviews SET status='cancelled' WHERE id=$1", [old.id]);
    const previousFetch = global.fetch;
    global.fetch = async () => { throw new Error('Synthetic unavailable n8n'); };
    process.env.AUTOMATION_PRO_ENABLED = 'true';
    try {
      const replacement = await service.schedule(payload);
      assert.notEqual(replacement.id, old.id);
      assert.equal(replacement.status, 'scheduled');
      assert.equal((await db.one("SELECT count(*)::int AS count FROM interviews WHERE status='scheduled'")).count, 1);
      assert.equal((await db.one("SELECT status FROM interviews WHERE id=$1", [old.id])).status, 'cancelled');
    } finally {
      global.fetch = previousFetch;
      process.env.AUTOMATION_PRO_ENABLED = 'false';
    }
  });

  test('the public fallback cannot report an existing slot as success when request details differ', async () => {
    const c = await candidate();
    const payload = schedulePayload(c.id);
    await service.scheduleByWorkflow(payload);
    const previousFetch = global.fetch;
    global.fetch = async () => { throw new Error('Synthetic unavailable n8n'); };
    process.env.AUTOMATION_PRO_ENABLED = 'true';
    try {
      for (const changed of [
        { durationMinutes: 60 }, { mode: 'onsite' },
        { meetingLink: 'https://example.invalid/changed' }, { notes: 'Changed location' },
      ]) await assert.rejects(service.schedule({ ...payload, ...changed }), error => error.getStatus() === 409);
      assert.equal((await db.one('SELECT count(*)::int AS count FROM interviews')).count, 1);
    } finally {
      global.fetch = previousFetch;
      process.env.AUTOMATION_PRO_ENABLED = 'false';
    }
  });

  test('both contained and containing time ranges are rejected', async () => {
    const c = await candidate();
    const first = schedulePayload(c.id, undefined, 60);
    await service.scheduleByWorkflow(first);
    for (const [offsetMinutes, durationMinutes] of [[15, 15], [-15, 90]]) {
      await assert.rejects(service.scheduleByWorkflow({ ...first, durationMinutes,
        startsAt: new Date(Date.parse(first.startsAt) + offsetMinutes * 60_000).toISOString() }),
      e => e.getStatus() === 409);
    }
  });

  test('an unanalyzed candidate cannot receive an interview', async () => {
    const c = await candidate({ ready: false });
    await assert.rejects(service.scheduleByWorkflow(schedulePayload(c.id)), e => e.getStatus() === 400);
    assert.equal((await db.one('SELECT count(*)::int AS count FROM interviews')).count, 0);
  });

  test('a successful invite is not sent again by webhook or retry', async () => {
    const i = await interview({ emailStatus: 'pending' });
    assert.equal((await service.sendInviteByWorkflow(i.id)).sent, true);
    assert.equal((await service.sendInviteByWorkflow(i.id)).alreadySent, true);
    assert.equal((await service.retry(i.id)).alreadySent, true);
    assert.deepEqual(mail.invites, [i.id]);
    assert.equal((await db.one('SELECT email_status FROM interviews WHERE id=$1', [i.id])).email_status, 'sent');
  });

  test('simultaneous invite webhooks send only one email', async () => {
    const i = await interview({ emailStatus: 'pending' });
    const started = deferred(), release = deferred();
    mail.sendInvite = async (row, beforeSend) => { started.resolve(); await release.promise; await beforeSend?.(); mail.invites.push(row.id); return { messageId: 'one', aiAssisted: false }; };
    const first = service.sendInviteByWorkflow(i.id);
    await started.promise;
    try {
      const competing = await Promise.all(Array.from({ length: 5 }, () => service.sendInviteByWorkflow(i.id)));
      assert.ok(competing.every(x => x.processing === true && x.sent === false));
      assert.deepEqual(mail.invites, []);
    } finally { release.resolve(); await first; }
  });

  test('SMTP failure remains retryable and a subsequent successful invite is sent once', async () => {
    const i = await interview({ emailStatus: 'pending' });
    const send = mail.sendInvite.bind(mail);
    mail.sendInvite = async (_row, beforeSend) => { await beforeSend?.(); throw Object.assign(new Error('Synthetic SMTP failure'), { responseCode: 535 }); };
    await assert.rejects(service.sendInviteByWorkflow(i.id), /Synthetic SMTP failure/);
    assert.equal((await db.one('SELECT email_status FROM interviews WHERE id=$1', [i.id])).email_status, 'failed');
    mail.sendInvite = send;
    assert.equal((await service.sendInviteByWorkflow(i.id)).sent, true);
    await service.sendInviteByWorkflow(i.id);
    assert.deepEqual(mail.invites, [i.id]);
  });

  test('cancelled and expired interviews cannot send invitations', async () => {
    for (const settings of [{ status: 'cancelled' }, { minutesUntil: -10 }]) {
      const i = await interview({ ...settings, emailStatus: 'pending' });
      await assert.rejects(service.sendInviteByWorkflow(i.id), e => e.getStatus() === 409);
    }
    assert.equal(mail.invites.length, 0);
  });

  test('an interview cancelled during invitation preparation is checked again before SMTP', async () => {
    const i = await interview({ emailStatus: 'pending' });
    const preparing = deferred(), release = deferred();
    mail.sendInvite = async (row, beforeSend) => {
      preparing.resolve();
      await release.promise;
      await beforeSend?.();
      mail.invites.push(row.id);
      return { messageId: 'must-not-send', aiAssisted: false };
    };
    const sending = service.sendInviteByWorkflow(i.id).catch(error => error);
    await preparing.promise;
    try { await db.rows("UPDATE interviews SET status='cancelled' WHERE id=$1", [i.id]); }
    finally { release.resolve(); }
    await sending;
    assert.equal(mail.invites.length, 0);
  });

  test('an ambiguous invitation delivery is retained for reconciliation and never automatically resent', async () => {
    const i = await interview({ emailStatus: 'pending' });
    mail.sendInvite = async (row, beforeSend) => {
      await beforeSend?.();
      mail.invites.push(row.id);
      throw Object.assign(new Error('Connection lost after SMTP delivery began'), { code: 'ECONNRESET' });
    };
    await service.sendInviteByWorkflow(i.id).catch(() => {});
    assert.equal((await db.one('SELECT email_status FROM interviews WHERE id=$1', [i.id])).email_status, 'unknown');
    await service.sendInviteByWorkflow(i.id).catch(() => {});
    await service.retry(i.id).catch(() => {});
    assert.deepEqual(mail.invites, [i.id]);
  });

  test('ECONNRESET remains ambiguous even when Nodemailer reports command CONN', async () => {
    const invite = await interview({ emailStatus: 'pending', minutesUntil: 48 * 60 });
    const reminder = await interview();
    const error = () => Object.assign(new Error('Synthetic socket reset'), { code: 'ECONNRESET', command: 'CONN' });
    mail.sendInvite = async (row, beforeSend) => { await beforeSend?.(); mail.invites.push(row.id); throw error(); };
    mail.sendReminder = async (row, beforeSend) => { await beforeSend?.(); mail.reminders.push(row.id); throw error(); };
    await service.sendInviteByWorkflow(invite.id).catch(() => {});
    assert.equal((await service.processReminders()).sent, 0);
    assert.equal((await db.one('SELECT email_status FROM interviews WHERE id=$1', [invite.id])).email_status, 'unknown');
    assert.equal((await db.one('SELECT reminder_status FROM interviews WHERE id=$1', [reminder.id])).reminder_status, 'unknown');
    await service.sendInviteByWorkflow(invite.id).catch(() => {});
    await service.processReminders();
    assert.deepEqual(mail.invites, [invite.id]);
    assert.deepEqual(mail.reminders, [reminder.id]);
  });

  test('audit database failures after SMTP success cannot turn accepted mail into retryable failures', async () => {
    const invite = await interview({ emailStatus: 'pending', minutesUntil: 48 * 60 });
    const reminder = await interview();
    await db.rows(`CREATE FUNCTION fail_mail_audit() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN RAISE EXCEPTION 'Synthetic audit database outage'; END $function$;
      CREATE TRIGGER fail_email_event BEFORE INSERT ON events FOR EACH ROW
        WHEN (NEW.category='email') EXECUTE FUNCTION fail_mail_audit();
      CREATE TRIGGER fail_mail_run BEFORE INSERT ON automation_runs FOR EACH ROW
        WHEN (NEW.workflow IN ('interview-invite','recruitment-followup')) EXECUTE FUNCTION fail_mail_audit();`);
    try {
      assert.equal((await service.sendInviteByWorkflow(invite.id)).sent, true);
      assert.equal((await service.processReminders()).sent, 1);
    } finally {
      await db.rows('DROP TRIGGER fail_email_event ON events; DROP TRIGGER fail_mail_run ON automation_runs; DROP FUNCTION fail_mail_audit()');
    }
    const inviteRow = await db.one('SELECT email_status,email_sent_at FROM interviews WHERE id=$1', [invite.id]);
    const reminderRow = await db.one('SELECT reminder_status,reminder_sent_at FROM interviews WHERE id=$1', [reminder.id]);
    assert.equal(inviteRow.email_status, 'sent');
    assert.ok(inviteRow.email_sent_at);
    assert.equal(reminderRow.reminder_status, 'sent');
    assert.ok(reminderRow.reminder_sent_at);
    assert.equal((await service.sendInviteByWorkflow(invite.id)).alreadySent, true);
    assert.equal((await service.processReminders()).sent, 0);
    assert.deepEqual(mail.invites, [invite.id]);
    assert.deepEqual(mail.reminders, [reminder.id]);
  });

  test('failure to persist SMTP acceptance keeps delivery protected and requires reconciliation', async () => {
    const invite = await interview({ emailStatus: 'pending', minutesUntil: 48 * 60 });
    const reminder = await interview();
    await db.rows(`CREATE FUNCTION fail_mail_confirmation() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN RAISE EXCEPTION 'Synthetic delivery confirmation database outage'; END $function$;
      CREATE TRIGGER fail_mail_confirmation BEFORE UPDATE ON interviews FOR EACH ROW
        WHEN ((NEW.email_status='sent' AND OLD.email_status<>'sent') OR
              (NEW.reminder_status='sent' AND OLD.reminder_status<>'sent'))
        EXECUTE FUNCTION fail_mail_confirmation();`);
    try {
      await assert.rejects(service.sendInviteByWorkflow(invite.id), e => e.getStatus() === 409);
      const result = await service.processReminders();
      assert.equal(result.sent, 0);
      assert.equal(result.unknown, 1);
    } finally {
      await db.rows('DROP TRIGGER fail_mail_confirmation ON interviews; DROP FUNCTION fail_mail_confirmation()');
    }
    const inviteRow = await db.one('SELECT email_status,email_delivery_started_at FROM interviews WHERE id=$1', [invite.id]);
    const reminderRow = await db.one('SELECT reminder_status,reminder_delivery_started_at FROM interviews WHERE id=$1', [reminder.id]);
    assert.equal(inviteRow.email_status, 'sending');
    assert.ok(inviteRow.email_delivery_started_at);
    assert.equal(reminderRow.reminder_status, 'sending');
    assert.ok(reminderRow.reminder_delivery_started_at);
    await db.rows(`UPDATE interviews SET email_attempt_started_at=now()-interval '4 minutes',
      reminder_attempt_started_at=now()-interval '4 minutes' WHERE id=ANY($1::uuid[])`, [[invite.id, reminder.id]]);
    await service.sendInviteByWorkflow(invite.id).catch(() => {});
    assert.equal((await service.processReminders()).sent, 0);
    assert.equal((await db.one('SELECT email_status FROM interviews WHERE id=$1', [invite.id])).email_status, 'unknown');
    assert.equal((await db.one('SELECT reminder_status FROM interviews WHERE id=$1', [reminder.id])).reminder_status, 'unknown');
    assert.deepEqual(mail.invites, [invite.id]);
    assert.deepEqual(mail.reminders, [reminder.id]);
  });

  test('an interrupted invitation after SMTP began becomes unknown instead of being resent', async () => {
    const i = await interview({ emailStatus: 'sending' });
    await db.rows(`UPDATE interviews SET email_attempt_started_at=now()-interval '4 minutes',
      email_delivery_started_at=now()-interval '4 minutes' WHERE id=$1`, [i.id]);
    await service.sendInviteByWorkflow(i.id).catch(() => {});
    assert.equal((await db.one('SELECT email_status FROM interviews WHERE id=$1', [i.id])).email_status, 'unknown');
    assert.equal(mail.invites.length, 0);
  });

  test('reminders require an active interview, sent invitation, and the 10 minute to 24 hour window', async () => {
    const eligible = await interview();
    for (const settings of [
      { status: 'cancelled' }, { emailStatus: 'pending' }, { emailStatus: 'failed' },
      { minutesUntil: -5 }, { minutesUntil: 10 }, { minutesUntil: 24 * 60 + 1 },
      { reminderStatus: 'sent', alreadyReminded: true }, { alreadyReminded: true },
    ]) await interview(settings);
    const result = await service.processReminders();
    assert.deepEqual(mail.reminders, [eligible.id]);
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.aiAssisted, 1);
    const repeated = await service.processReminders();
    assert.equal(repeated.sent, 0);
    assert.equal(mail.reminders.length, 1);
  });

  test('the upper reminder boundary includes an interview 24 hours away', async () => {
    const i = await interview({ minutesUntil: 24 * 60 });
    assert.equal((await service.processReminders()).sent, 1);
    assert.deepEqual(mail.reminders, [i.id]);
  });

  test('reminder eligibility is checked again after preparation, before SMTP', async () => {
    const i = await interview();
    const preparing = deferred(), release = deferred();
    mail.sendReminder = async (row, beforeSend) => {
      preparing.resolve();
      await release.promise;
      await beforeSend?.();
      mail.reminders.push(row.id);
      return { messageId: 'must-not-send', aiAssisted: false };
    };
    const sending = service.processReminders();
    await preparing.promise;
    try { await db.rows("UPDATE interviews SET status='cancelled' WHERE id=$1", [i.id]); }
    finally { release.resolve(); }
    assert.equal((await sending).sent, 0);
    assert.equal(mail.reminders.length, 0);
  });

  test('interrupted reminder leases recover while a fresh lease remains protected', async () => {
    const stale = await interview({ reminderStatus: 'sending' });
    const missing = await interview({ reminderStatus: 'sending' });
    const fresh = await interview({ reminderStatus: 'sending' });
    await db.rows("UPDATE interviews SET reminder_attempt_started_at=now()-interval '4 minutes' WHERE id=$1", [stale.id]);
    await db.rows('UPDATE interviews SET reminder_attempt_started_at=now() WHERE id=$1', [fresh.id]);
    const result = await service.processReminders();
    assert.deepEqual(new Set(mail.reminders), new Set([stale.id, missing.id]));
    assert.equal(result.sent, 2);
    assert.equal((await db.one('SELECT reminder_status FROM interviews WHERE id=$1', [fresh.id])).reminder_status, 'sending');
  });

  test('two reminder workers report only their actual deliveries', async () => {
    for (let i = 0; i < 5; i++) await interview();
    const send = mail.sendReminder.bind(mail);
    mail.sendReminder = async (row, beforeSend) => { await new Promise(resolve => setTimeout(resolve, 15)); return send(row, beforeSend); };
    const results = await Promise.all([service.processReminders(), service.processReminders()]);
    assert.equal(mail.reminders.length, 5);
    assert.equal(new Set(mail.reminders).size, 5);
    assert.equal(results.reduce((total, result) => total + result.sent, 0), 5);
    assert.equal(results.reduce((total, result) => total + result.failed, 0), 0);
    assert.equal(results.reduce((total, result) => total + result.aiAssisted, 0), 5);
  });

  test('failed reminders retain the error and can succeed on the next run', async () => {
    const i = await interview();
    const send = mail.sendReminder.bind(mail);
    mail.sendReminder = async (_row, beforeSend) => { await beforeSend?.(); throw Object.assign(new Error('Synthetic reminder SMTP failure'), { responseCode: 535 }); };
    const first = await service.processReminders();
    assert.equal(first.sent, 0);
    assert.equal(first.failed, 1);
    const failed = await db.one('SELECT reminder_status,reminder_error,reminder_sent_at FROM interviews WHERE id=$1', [i.id]);
    assert.equal(failed.reminder_status, 'failed');
    assert.match(failed.reminder_error, /Synthetic reminder SMTP failure/);
    assert.equal(failed.reminder_sent_at, null);
    mail.sendReminder = send;
    assert.equal((await service.processReminders()).sent, 1);
    assert.equal((await db.one('SELECT reminder_status FROM interviews WHERE id=$1', [i.id])).reminder_status, 'sent');
  });

  test('an ambiguous reminder delivery is never blindly retried', async () => {
    const i = await interview();
    mail.sendReminder = async (row, beforeSend) => {
      await beforeSend?.();
      mail.reminders.push(row.id);
      throw Object.assign(new Error('Connection lost after SMTP delivery began'), { code: 'ECONNRESET' });
    };
    const first = await service.processReminders();
    assert.equal(first.sent, 0);
    assert.equal((await db.one('SELECT reminder_status FROM interviews WHERE id=$1', [i.id])).reminder_status, 'unknown');
    assert.equal((await service.processReminders()).sent, 0);
    assert.deepEqual(mail.reminders, [i.id]);
  });

  test('a reminder interrupted after SMTP began becomes unknown without redelivery', async () => {
    const i = await interview({ reminderStatus: 'sending' });
    await db.rows(`UPDATE interviews SET reminder_attempt_started_at=now()-interval '4 minutes',
      reminder_delivery_started_at=now()-interval '4 minutes' WHERE id=$1`, [i.id]);
    assert.equal((await service.processReminders()).sent, 0);
    assert.equal((await db.one('SELECT reminder_status FROM interviews WHERE id=$1', [i.id])).reminder_status, 'unknown');
    assert.equal(mail.reminders.length, 0);
  });

  test('an old reminder worker cannot overwrite a recovered successful delivery', async () => {
    const i = await interview();
    const started = deferred(), finishOld = deferred();
    let attempts = 0;
    mail.sendReminder = async (row, beforeSend) => {
      if (++attempts === 1) { started.resolve(); await finishOld.promise; }
      await beforeSend?.();
      mail.reminders.push(row.id);
      return { messageId: 'recovered', aiAssisted: false };
    };
    const oldRun = service.processReminders();
    await started.promise;
    try {
      await db.rows("UPDATE interviews SET reminder_attempt_started_at=now()-interval '4 minutes' WHERE id=$1", [i.id]);
      assert.equal((await service.processReminders()).sent, 1);
    } finally { finishOld.resolve(); }
    const oldResult = await oldRun;
    assert.equal(oldResult.failed, 0, 'Superseded workers must not report a failure for the recovered delivery');
    const row = await db.one('SELECT reminder_status,reminder_error,reminder_sent_at FROM interviews WHERE id=$1', [i.id]);
    assert.equal(row.reminder_status, 'sent');
    assert.equal(row.reminder_error, null);
    assert.ok(row.reminder_sent_at);
    assert.deepEqual(mail.reminders, [i.id], 'The expired worker must not start a second SMTP delivery');
  });

  test('an old invitation worker cannot overwrite a recovered successful delivery', async () => {
    const i = await interview({ emailStatus: 'pending' });
    const started = deferred(), finishOld = deferred();
    let attempts = 0;
    mail.sendInvite = async (row, beforeSend) => {
      if (++attempts === 1) { started.resolve(); await finishOld.promise; }
      await beforeSend?.();
      mail.invites.push(row.id);
      return { messageId: 'recovered-invite', aiAssisted: false };
    };
    const oldRun = service.sendInviteByWorkflow(i.id).catch(error => error);
    await started.promise;
    try {
      await db.rows("UPDATE interviews SET email_attempt_started_at=now()-interval '4 minutes' WHERE id=$1", [i.id]);
      assert.equal((await service.sendInviteByWorkflow(i.id)).sent, true);
    } finally { finishOld.resolve(); }
    await oldRun;
    const row = await db.one('SELECT email_status,email_error,email_sent_at FROM interviews WHERE id=$1', [i.id]);
    assert.equal(row.email_status, 'sent');
    assert.equal(row.email_error, null);
    assert.ok(row.email_sent_at);
    assert.deepEqual(mail.invites, [i.id], 'The expired worker must not start a second SMTP delivery');
  });

  test('reapplying migration 005 preserves unknown deliveries and repairs acknowledged false failures', async () => {
    const unknown = await interview({ emailStatus: 'unknown', reminderStatus: 'unknown' });
    await db.rows(`UPDATE interviews SET email_error='Keep invite reconciliation evidence',
      reminder_error='Keep reminder reconciliation evidence',email_message_id='unknown-invite',
      reminder_message_id='unknown-reminder' WHERE id=$1`, [unknown.id]);
    const acknowledged = await interview({ emailStatus: 'failed', reminderStatus: 'failed', alreadyReminded: true });
    await db.rows(`UPDATE interviews SET email_sent_at=now(),email_error='Audit failed after send',
      reminder_error='Audit failed after reminder',email_message_id='accepted-invite',
      reminder_message_id='accepted-reminder' WHERE id=$1`, [acknowledged.id]);
    const prior = await db.one('SELECT email_sent_at,reminder_sent_at FROM interviews WHERE id=$1', [acknowledged.id]);
    const legacy = await interview({ emailStatus: 'sending', reminderStatus: 'sending' });
    const migration = readFileSync(path.join(root, 'sql/005_interview_reliability.sql'), 'utf8');
    await db.rows(migration);
    await db.rows(migration);
    const preserved = await db.one('SELECT * FROM interviews WHERE id=$1', [unknown.id]);
    assert.equal(preserved.email_status, 'unknown');
    assert.equal(preserved.reminder_status, 'unknown');
    assert.equal(preserved.email_error, 'Keep invite reconciliation evidence');
    assert.equal(preserved.reminder_error, 'Keep reminder reconciliation evidence');
    assert.equal(preserved.email_message_id, 'unknown-invite');
    assert.equal(preserved.reminder_message_id, 'unknown-reminder');
    const repaired = await db.one('SELECT * FROM interviews WHERE id=$1', [acknowledged.id]);
    assert.equal(repaired.email_status, 'sent');
    assert.equal(repaired.reminder_status, 'sent');
    assert.equal(repaired.email_error, null);
    assert.equal(repaired.reminder_error, null);
    assert.deepEqual(repaired.email_sent_at, prior.email_sent_at);
    assert.deepEqual(repaired.reminder_sent_at, prior.reminder_sent_at);
    assert.equal(repaired.email_message_id, 'accepted-invite');
    assert.equal(repaired.reminder_message_id, 'accepted-reminder');
    const protectedLegacy = await db.one('SELECT * FROM interviews WHERE id=$1', [legacy.id]);
    assert.ok(protectedLegacy.email_delivery_started_at);
    assert.ok(protectedLegacy.reminder_delivery_started_at);
    assert.equal((await service.processReminders()).sent, 0);
    assert.equal((await db.one('SELECT email_status FROM interviews WHERE id=$1', [legacy.id])).email_status, 'unknown');
    assert.equal((await db.one('SELECT reminder_status FROM interviews WHERE id=$1', [legacy.id])).reminder_status, 'unknown');
    assert.deepEqual(mail.invites, []);
    assert.deepEqual(mail.reminders, []);
  });
}
