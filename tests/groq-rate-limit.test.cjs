/*
 * Groq HTTP behavior with mocked fetch and virtual time; no network or .env.
 * Run from the repo root: node --test tests/groq-rate-limit.test.cjs
 */
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, test } = require('node:test');
const { mkdtempSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'talentflow-groq-tests-'));
const originalFetch = global.fetch;
const savedEnv = new Map(['GROQ_API_KEY', 'GROQ_MODEL'].map(key => [key, process.env[key]]));
const now = Date.parse('2026-10-24T00:00:00Z');
const job = { title: 'Test engineer', description: 'Build reliable services', requirements: 'TypeScript and SQL' };
const cv = 'Synthetic candidate with TypeScript experience and a SQL project. contact@example.invalid';
const review = { score: 78, summary: 'Có kinh nghiệm liên quan.', strengths: ['TypeScript'],
  gaps: ['Cần xác minh SQL'], skills: ['TypeScript'], confidence: 'medium' };
let GroqService;

function completion(value) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
function rateLimited(message = 'Rate limit reached. Please try again in 28s.', headers = {}) {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 429, headers: { 'content-type': 'application/json', ...headers },
  });
}
function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}
function observe(promise) {
  const result = { state: 'pending' };
  result.promise = promise.then(value => { result.state = 'fulfilled'; result.value = value; },
    error => { result.state = 'rejected'; result.error = error; });
  return result;
}
async function settle() {
  // Flush promise chains, including Response.text() and queue handoffs.
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
async function advance(t, milliseconds) {
  t.mock.timers.tick(milliseconds);
  await settle();
}
function rejected(result) {
  assert.equal(result.state, 'rejected');
  assert.ok(result.error instanceof Error);
  assert.ok(result.error.message.length > 0);
}

before(() => {
  const compiled = spawnSync(path.join(root, 'backend/node_modules/.bin/tsc'),
    ['--project', path.join(root, 'backend/tsconfig.json'), '--outDir', temp], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, `Backend compilation failed:\n${compiled.stdout}\n${compiled.stderr}`);
  symlinkSync(path.join(root, 'backend/node_modules'), path.join(temp, 'node_modules'), 'dir');
  ({ GroqService } = require(path.join(temp, 'groq.js')));
});

beforeEach(t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  process.env.GROQ_API_KEY = 'synthetic-test-key';
  process.env.GROQ_MODEL = 'openai/gpt-oss-120b';
  global.fetch = async () => { throw new Error('Unexpected external HTTP call during Groq tests'); };
});
afterEach(() => { global.fetch = originalFetch; });
after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  global.fetch = originalFetch;
  rmSync(temp, { recursive: true, force: true });
});

test('a TPM 429 waits for Retry-After and then returns a real validated review', async t => {
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push({ time: Date.now(), body: JSON.parse(options.body) });
    return calls.length === 1 ? rateLimited('Rate limit reached.', { 'retry-after': '28' }) : completion(review);
  };
  const result = observe(new GroqService().review(job, cv));
  await settle();
  assert.equal(calls.length, 1);
  await advance(t, 27_999);
  assert.equal(calls.length, 1, 'a retry must not precede the provider delay');
  await advance(t, 1_001);
  assert.equal(result.state, 'fulfilled');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].time - calls[0].time >= 28_000);
  assert.deepEqual(result.value, review);
  assert.equal(calls[0].body.model, calls[1].body.model, 'rate limits must not switch the model');
  assert.ok(!calls[0].body.messages[1].content.includes('contact@example.invalid'), 'contact redaction remains active');
});

test('fractional retry hints are read from the complete error before display truncation', async t => {
  const calls = [];
  const message = `Rate limit reached. ${'Provider details. '.repeat(24)}Please try again in 27.8925s.`;
  global.fetch = async () => {
    calls.push(Date.now());
    return calls.length === 1 ? rateLimited(message) : completion(review);
  };
  const result = observe(new GroqService().review(job, cv));
  await settle();
  await advance(t, 27_892);
  assert.equal(calls.length, 1);
  await advance(t, 1_001);
  assert.equal(calls.length, 2);
  assert.equal(result.state, 'fulfilled');
  assert.ok(calls[1] - calls[0] >= 27_892.5);
});

test('Retry-After takes precedence over a shorter delay in the error message', async t => {
  let calls = 0;
  global.fetch = async () => ++calls === 1
    ? rateLimited('Please try again in 1s.', { 'retry-after': '4.5' }) : completion(review);
  const result = observe(new GroqService().review(job, cv));
  await settle();
  await advance(t, 4_499);
  assert.equal(calls, 1);
  await advance(t, 1_001);
  assert.equal(result.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('HTTP-date Retry-After headers are respected', async t => {
  let calls = 0;
  const retryAt = new Date(now + 4_000).toUTCString();
  global.fetch = async () => ++calls === 1
    ? rateLimited('Rate limit reached.', { 'retry-after': retryAt }) : completion(review);
  const result = observe(new GroqService().review(job, cv));
  await settle();
  await advance(t, 3_999);
  assert.equal(calls, 1);
  await advance(t, 1_001);
  assert.equal(result.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('a request larger than the entire TPM limit fails without futile retries', async t => {
  let calls = 0;
  const message = 'Rate limit reached on tokens per minute (TPM): Limit 8000, Used 0, Requested 9000. Please try again in 5s.';
  global.fetch = async () => { calls++; return rateLimited(message, { 'retry-after': '5' }); };
  const result = observe(new GroqService().review(job, cv));
  await settle();
  rejected(result);
  assert.equal(calls, 1);
  await advance(t, 60_000);
  assert.equal(calls, 1);
});

test('an excessive retry delay fails promptly and keeps a shared cooldown', async t => {
  let calls = 0;
  global.fetch = async () => ++calls === 1
    ? rateLimited('Please try again in 120s.', { 'retry-after': '120' }) : completion(review);
  const service = new GroqService();
  const first = observe(service.review(job, cv));
  await settle();
  rejected(first);
  assert.equal(calls, 1);
  const next = observe(service.composeInterviewCopy('invite', { job_title: job.title, mode: 'online' }));
  await settle();
  rejected(next);
  assert.equal(calls, 1, 'another Groq feature cannot send during the cooldown');
  await advance(t, 121_000);
  const recovered = observe(service.review(job, cv));
  await settle();
  assert.equal(recovered.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('repeated short 429s stop after at most three HTTP attempts', async t => {
  let calls = 0;
  global.fetch = async () => { calls++; return rateLimited('Please try again in 1s.', { 'retry-after': '1' }); };
  const result = observe(new GroqService().review(job, cv));
  await settle();
  for (let i = 0; i < 3; i++) await advance(t, 2_000);
  rejected(result);
  assert.ok(calls >= 2 && calls <= 3, `expected bounded retries, got ${calls}`);
  await advance(t, 60_000);
  assert.ok(calls <= 3, 'no orphaned retry runs after failure');
});

test('a 429 without usable timing information does not retry in a tight loop', async t => {
  for (const header of [undefined, '-5', 'not-a-delay']) {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return rateLimited('Rate limit reached.', header === undefined ? {} : { 'retry-after': header });
    };
    const result = observe(new GroqService().review(job, cv));
    await settle();
    assert.equal(calls, 1);
    await advance(t, 100);
    assert.equal(calls, 1);
    await advance(t, 56_000);
    rejected(result);
    assert.ok(calls <= 3);
  }
});

test('a 429 without a retry hint still prevents subsequent calls for a minute', async t => {
  let calls = 0;
  global.fetch = async () => ++calls === 1 ? rateLimited('Rate limit reached.') : completion(review);
  const service = new GroqService();
  const first = observe(service.review(job, cv));
  await settle();
  rejected(first);
  assert.equal(calls, 1);
  const next = observe(service.review(job, cv));
  await settle();
  rejected(next);
  assert.equal(calls, 1, 'missing provider hints must not permit immediate requests');
  await advance(t, 61_000);
  const recovered = observe(service.review(job, cv));
  await settle();
  assert.equal(recovered.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('mixed duration hints beyond the screening budget fail without retrying', async t => {
  let calls = 0;
  global.fetch = async () => { calls++; return rateLimited('Please try again in 1m2.5s.'); };
  const result = observe(new GroqService().review(job, cv));
  await settle();
  rejected(result);
  assert.equal(calls, 1);
  await advance(t, 64_000);
  assert.equal(calls, 1, 'a rejected request cannot retry after its deadline');
});

test('reviews and interview copy share a single outbound queue', async () => {
  const gate = deferred();
  let calls = 0;
  global.fetch = async () => ++calls === 1 ? gate.promise : completion({ copy: 'Mời bạn trao đổi về chuyên môn.' });
  const service = new GroqService();
  const first = observe(service.review(job, cv));
  const second = observe(service.composeInterviewCopy('invite', { job_title: job.title, mode: 'online' }));
  await settle();
  assert.equal(calls, 1);
  assert.equal(second.state, 'pending');
  gate.resolve(completion(review));
  await settle();
  assert.equal(first.state, 'fulfilled');
  assert.equal(second.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('an interview request expires in the queue and is never sent later', async t => {
  const gate = deferred();
  let calls = 0;
  global.fetch = async () => { calls++; return gate.promise; };
  const service = new GroqService();
  const first = observe(service.review(job, cv));
  const queued = observe(service.composeInterviewCopy('invite', { job_title: job.title, mode: 'online' }));
  await settle();
  assert.equal(calls, 1);
  await advance(t, 13_000);
  rejected(queued);
  assert.equal(calls, 1);
  gate.resolve(completion(review));
  await settle();
  assert.equal(first.state, 'fulfilled');
  assert.equal(calls, 1, 'expired queued work must never consume quota');
});

test('interview generation also honors a short provider retry delay', async t => {
  let calls = 0;
  global.fetch = async () => ++calls === 1
    ? rateLimited('Please try again in 1s.', { 'retry-after': '1' }) : completion({ copy: 'Mời bạn trao đổi về chuyên môn.' });
  const result = observe(new GroqService().composeInterviewCopy('invite', { job_title: job.title, mode: 'online' }));
  await settle();
  await advance(t, 999);
  assert.equal(calls, 1);
  await advance(t, 1_001);
  assert.equal(result.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('authentication errors are not retried and do not block the next request', async () => {
  let calls = 0;
  global.fetch = async () => ++calls === 1
    ? new Response(JSON.stringify({ error: { message: 'Synthetic invalid key' } }), { status: 401 })
    : completion(review);
  const service = new GroqService();
  const first = observe(service.review(job, cv));
  const next = observe(service.review(job, cv));
  await settle();
  rejected(first);
  assert.equal(next.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('invalid successful responses remain errors and release the queue', async () => {
  let calls = 0;
  global.fetch = async () => ++calls === 1 ? completion({ ...review, score: 101 }) : completion(review);
  const service = new GroqService();
  const invalid = observe(service.review(job, cv));
  const next = observe(service.review(job, cv));
  await settle();
  rejected(invalid);
  assert.equal(next.state, 'fulfilled');
  assert.equal(calls, 2);
});

test('network timeouts and retries stay within the 55-second screening budget', async t => {
  let calls = 0;
  global.fetch = async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('Synthetic aborted fetch'), { name: 'AbortError' }));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  };
  const result = observe(new GroqService().review(job, cv));
  await settle();
  await advance(t, 35_000);
  await advance(t, 1_000);
  await advance(t, 19_000);
  await advance(t, 1_000);
  rejected(result);
  assert.ok(calls <= 3);
});

test('an absent Groq key fails without making an HTTP request', async () => {
  delete process.env.GROQ_API_KEY;
  let calls = 0;
  global.fetch = async () => { calls++; return completion(review); };
  const result = observe(new GroqService().review(job, cv));
  await settle();
  rejected(result);
  assert.equal(calls, 0);
});
