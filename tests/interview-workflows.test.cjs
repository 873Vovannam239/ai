/*
 * Exercise the checked-in n8n Code nodes and webhook responses without n8n,
 * SMTP, Groq, or a database. Run: node --test tests/interview-workflows.test.cjs
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const workflows = new Map();
function workflow(file) {
  if (!workflows.has(file)) workflows.set(file, JSON.parse(readFileSync(path.join(__dirname, '..', 'n8n', file), 'utf8')));
  return workflows.get(file);
}
function node(file, name) {
  const found = workflow(file).nodes.find(n => n.name === name);
  assert.ok(found, `${file}: missing node ${name}`);
  return found;
}
function runCode(file, name, payload) {
  const target = node(file, name);
  assert.equal(target.type, 'n8n-nodes-base.code');
  return new Function('$json', target.parameters.jsCode)(payload)[0].json;
}
function expression(value, payload) {
  if (typeof value !== 'string' || !value.startsWith('={{')) return value;
  assert.ok(value.endsWith('}}'));
  return new Function('$json', `return (${value.slice(3, -2)});`)(payload);
}
function response(file, name, payload) {
  const params = node(file, name).parameters;
  return { statusCode: expression(params.options.responseCode, payload), body: expression(params.responseBody, payload) };
}
const inviteFile = 'recruitment-invite.workflow.json';
const scheduleFile = 'recruitment-schedule-interview.workflow.json';
const reminderFile = 'recruitment-followup.workflow.json';
const invite = payload => runCode(inviteFile, '05 · Evaluate backend result', payload);
const schedule = payload => runCode(scheduleFile, '05 · Evaluate backend result', payload);
const envelope = (body, statusCode = 200) => ({ body, statusCode });

for (const [label, body] of [
  ['new SMTP confirmation', { sent: true, messageId: 'demo-id' }],
  ['already sent', { sent: true, alreadySent: true }],
]) test(`invitation success: ${label}`, () => {
  const result = invite(envelope(body));
  assert.equal(result.ok, true);
  const rendered = response(inviteFile, '07 · Respond success', result);
  assert.equal(rendered.statusCode, 200);
  assert.deepEqual(rendered.body.result, body);
  assert.equal(rendered.body.ok, true);
});

test('an active invitation claim responds 202 without claiming delivery', () => {
  const result = invite(envelope({ sent: false, processing: true }));
  const rendered = response(inviteFile, '07 · Respond pending or failed', result);
  assert.equal(rendered.statusCode, 202);
  assert.equal(rendered.body.ok, false);
  assert.equal(rendered.body.status, 'processing');
  assert.equal(rendered.body.result.sent, false);
});

test('an unknown SMTP result remains unknown and responds 409', () => {
  const result = invite(envelope({ unknown: true, status: 'unknown', message: 'Reconcile SMTP delivery' }, 409));
  const rendered = response(inviteFile, '07 · Respond pending or failed', result);
  assert.equal(rendered.statusCode, 409);
  assert.equal(rendered.body.status, 'unknown');
  assert.equal(rendered.body.ok, false);
  assert.match(rendered.body.error, /Reconcile/);
});

for (const statusCode of [400, 404, 409]) test(`schedule preserves backend HTTP ${statusCode}`, () => {
  const result = schedule(envelope({ statusCode, error: 'Business error', message: `Backend ${statusCode}` }, statusCode));
  const rendered = response(scheduleFile, '07 · Respond partial or failed', result);
  assert.equal(rendered.statusCode, statusCode);
  assert.equal(rendered.body.ok, false);
  assert.equal(rendered.body.scheduleSaved, false);
  assert.match(rendered.body.error, new RegExp(String(statusCode)));
});

test('a saved interview with confirmed invitation responds success', () => {
  const result = schedule(envelope({ id: 'demo-interview', automation: { ok: true } }, 201));
  const rendered = response(scheduleFile, '07 · Respond success', result);
  assert.equal(rendered.statusCode, 200);
  assert.equal(rendered.body.ok, true);
  assert.equal(rendered.body.scheduleSaved, true);
});

test('a saved interview with unconfirmed email responds partial and preserves its ID', () => {
  const result = schedule(envelope({ id: 'demo-interview', automation: { ok: false, message: 'SMTP failed' } }, 201));
  const rendered = response(scheduleFile, '07 · Respond partial or failed', result);
  assert.equal(rendered.statusCode, 207);
  assert.equal(rendered.body.ok, false);
  assert.equal(rendered.body.status, 'partial');
  assert.equal(rendered.body.scheduleSaved, true);
  assert.equal(rendered.body.result.id, 'demo-interview');
  assert.match(rendered.body.error, /SMTP failed/);
});

test('empty backend responses and network failures never confirm completion', () => {
  assert.equal(schedule(envelope({})).ok, false);
  const failed = invite({ error: { message: 'Network timeout' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.httpStatus, 502);
  assert.match(failed.error, /Network timeout/);
  assert.equal(invite(envelope({ sent: false, alreadySent: true })).ok, false);
});

const reminderCases = [
  ['no work due', { due: 0, sent: 0, failed: 0, status: 'success' }, true, 'success', 200],
  ['all delivered', { due: 2, sent: 2, failed: 0, status: 'success' }, true, 'success', 200],
  ['one completed elsewhere', { due: 2, sent: 1, skipped: 1, failed: 0, status: 'success' }, true, 'success', 200],
  ['all became ineligible', { due: 1, sent: 0, skipped: 1, failed: 0, status: 'success' }, true, 'success', 200],
  ['mixed SMTP outcomes', { due: 2, sent: 1, failed: 1, status: 'partial' }, false, 'partial', 207],
  ['all failed', { due: 1, sent: 0, failed: 1, status: 'failed' }, false, 'failed', 502],
  ['another worker still sending', { due: 1, sent: 0, failed: 0, processing: 1, status: 'partial' }, false, 'partial', 207],
  ['unknown delivery', { due: 1, sent: 0, failed: 0, unknown: 1, status: 'failed' }, false, 'failed', 502],
  ['wrong success flag', { due: 1, sent: 0, failed: 1, status: 'success' }, false, 'failed', 502],
  ['incomplete counts', { due: 1, sent: 0, failed: 0, status: 'success' }, false, 'failed', 502],
  ['impossible counts', { due: 0, sent: 1, failed: 0 }, false, 'failed', 502],
  ['invalid counts', { due: 1, sent: 0, failed: -1 }, false, 'failed', 502],
  ['global recovery count is independent', { due: 0, sent: 0, failed: 0, recovered: 3, status: 'success' }, true, 'success', 200],
];
for (const [label, body, ok, status, httpStatus] of reminderCases) test(`reminder summary: ${label}`, () => {
  for (const evaluator of ['05 · Evaluate manual result', 'Evaluate scheduled reminder result']) {
    const result = runCode(reminderFile, evaluator, envelope(body));
    assert.equal(result.ok, ok, evaluator);
    assert.equal(result.status, status, evaluator);
    assert.equal(result.httpStatus, httpStatus, evaluator);
    assert.deepEqual(result.result, body, 'reported delivery counts must remain unchanged');
  }
  const result = runCode(reminderFile, '05 · Evaluate manual result', envelope(body));
  const rendered = response(reminderFile, ok ? 'Respond manual success' : 'Respond manual failure', result);
  assert.equal(rendered.statusCode, httpStatus);
  assert.equal(rendered.body.ok, ok);
  assert.deepEqual(rendered.body.result, body);
});

test('scheduled reminder failure throws so the n8n execution can fail', () => {
  assert.throws(() => runCode(reminderFile, 'Finish – scheduled reminders failed', { error: 'Synthetic SMTP failure' }), /Synthetic SMTP failure/);
});

test('all interview HTTP nodes expose backend status and body to their evaluators', () => {
  for (const file of [inviteFile, scheduleFile, reminderFile]) {
    for (const target of workflow(file).nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest')) {
      const options = target.parameters.options.response.response;
      assert.equal(options.fullResponse, true, `${file}: full response`);
      assert.equal(options.neverError, true, `${file}: preserve business errors`);
      assert.equal(options.responseFormat, 'json', `${file}: JSON body`);
    }
  }
});
