'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildLaunchdPlist,
  endpointPath,
  errorToJson,
  MAX_AUTH_FILE_BYTES,
  normalizeCredits,
  normalizeBaseUrl,
  parseArgs,
  readAuth,
  readResponseText,
  redactBodyForError,
  summarizePayload,
} = require('../bin/codex-resets.js');

test('parseArgs reads global flags and command args', () => {
  const parsed = parseArgs(['--json', '--auth-file', '~/tmp/auth.json', '--tz', 'UTC', '--show-identifiers', 'credits', 'list', '--all']);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.authFile.endsWith('/tmp/auth.json'), true);
  assert.equal(parsed.options.timeZone, 'UTC');
  assert.equal(parsed.options.showIdentifiers, true);
  assert.deepEqual(parsed.args, ['credits', 'list', '--all']);
});

test('normalizeBaseUrl allows only OpenAI backend API hosts', () => {
  assert.equal(normalizeBaseUrl('https://chatgpt.com/backend-api/'), 'https://chatgpt.com/backend-api');
  assert.equal(normalizeBaseUrl('https://chat.openai.com/backend-api'), 'https://chat.openai.com/backend-api');
  assert.throws(() => normalizeBaseUrl('http://chatgpt.com/backend-api'), /must use https/);
  assert.throws(() => normalizeBaseUrl('https://example.com/backend-api'), /not allowed/);
  assert.throws(() => normalizeBaseUrl('https://chatgpt.com/not-backend'), /must end with/);
});

test('endpointPath normalizes relative paths and rejects absolute URLs', () => {
  assert.equal(endpointPath('wham/rate-limit-reset-credits'), '/wham/rate-limit-reset-credits');
  assert.equal(endpointPath('/wham/rate-limit-reset-credits'), '/wham/rate-limit-reset-credits');
  assert.throws(() => endpointPath('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits?x=1'), /must be relative/);
});

test('errorToJson redacts custom auth file paths and secret-bearing details by default', () => {
  const error = new Error('Codex auth file not found');
  error.code = 'AUTH_FILE_MISSING';
  error.details = {
    authFile: '/Users/example/private/path/auth.json',
    body: {
      access_token: 'secret-token',
      harmless: 'kept',
    },
  };
  const redacted = errorToJson(error, { showIdentifiers: false });
  assert.equal(redacted.details.authFile, '[redacted auth file path]');
  assert.equal(redacted.details.body.access_token, '[redacted]');
  assert.equal(redacted.details.body.harmless, 'kept');

  const identified = errorToJson(error, { showIdentifiers: true });
  assert.equal(identified.details.authFile, '/Users/example/private/path/auth.json');
});

test('redactBodyForError redacts bearer values and JWT-looking strings in strings and JSON values', () => {
  const token = 'eyJhbGciOi.testpayload.testsignature';
  assert.equal(
    redactBodyForError(`upstream echoed Authorization: Bearer ${token}`, token),
    'upstream echoed Authorization: Bearer [redacted]',
  );
  assert.deepEqual(
    redactBodyForError({ message: `Bearer ${token}`, nested: { note: token } }, token),
    { message: 'Bearer [redacted]', nested: { note: '[redacted]' } },
  );
});

test('readAuth rejects non-regular and oversized auth paths before reading', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resets-test-'));
  try {
    assert.throws(() => readAuth(tmpDir), /not a regular file/);

    const hugeAuth = path.join(tmpDir, 'auth.json');
    fs.writeFileSync(hugeAuth, 'x'.repeat(MAX_AUTH_FILE_BYTES + 1));
    assert.throws(() => readAuth(hugeAuth), /larger than/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readResponseText enforces a response size cap', async () => {
  await assert.rejects(
    () => readResponseText(new Response('abcdef'), 5),
    /Response exceeded/,
  );
  assert.equal(await readResponseText(new Response('abc'), 5), 'abc');
});

test('normalizeCredits filters available credits, sorts by expiration, and redacts identifiers by default', () => {
  const payload = {
    credits: [
      { id: 'b', status: 'available', expires_at: '2026-07-18T00:37:49Z', title: 'B', profile_user_id: '@b' },
      { id: 'x', status: 'redeemed', expires_at: '2026-07-01T00:00:00Z', title: 'X' },
      { id: 'a', status: 'available', expires_at: '2026-07-16T04:32:56Z', title: 'A', profile_user_id: '@a' },
    ],
  };
  const credits = normalizeCredits(payload, 'UTC', false);
  assert.deepEqual(credits.map((credit) => credit.title), ['A', 'B']);
  assert.equal(Object.hasOwn(credits[0], 'id'), false);
  assert.equal(Object.hasOwn(credits[0], 'source'), false);
  const identifiedCredits = normalizeCredits(payload, 'UTC', false, { showIdentifiers: true });
  assert.deepEqual(identifiedCredits.map((credit) => credit.id), ['a', 'b']);
  assert.deepEqual(identifiedCredits.map((credit) => credit.source), ['@a', '@b']);
});

test('summarizePayload returns counts and next expiration', () => {
  const summary = summarizePayload({
    available_count: 2,
    total_earned_count: 1,
    credits: [
      { id: 'b', status: 'available', expires_at: '2026-07-18T00:37:49Z', title: 'B' },
      { id: 'a', status: 'available', expires_at: '2026-07-16T04:32:56Z', title: 'A' },
      { id: 'r', status: 'redeemed', expires_at: '2026-07-01T00:00:00Z', title: 'R' },
    ],
  }, 'UTC');
  assert.equal(summary.available_count, 2);
  assert.equal(summary.total_earned_count, 1);
  assert.deepEqual(summary.counts_by_status, { available: 2, redeemed: 1 });
  assert.equal(summary.next_expiring_credit.title, 'A');
  assert.equal(Object.hasOwn(summary.next_expiring_credit, 'id'), false);
});

test('buildLaunchdPlist creates safe LaunchAgent XML without personal defaults', () => {
  const schedule = buildLaunchdPlist(['--interval-minutes', '15', '--log-dir', '/tmp/codex-resets'], 'codex-resets');
  assert.equal(schedule.interval_seconds, 900);
  assert.equal(schedule.label, 'com.codex-resets.check');
  assert.equal(schedule.plist_path.endsWith('/Library/LaunchAgents/com.codex-resets.check.plist'), true);
  assert.match(schedule.plist, /<string>\/usr\/bin\/env<\/string>/);
  assert.match(schedule.plist, /<string>codex-resets<\/string>/);
  assert.match(schedule.plist, /<integer>900<\/integer>/);
  assert.doesNotMatch(schedule.plist, /sourav/i);
});

test('buildLaunchdPlist rejects labels that could escape LaunchAgents', () => {
  assert.throws(() => buildLaunchdPlist(['--label', '../outside'], 'codex-resets'), /reverse-DNS style/);
  assert.throws(() => buildLaunchdPlist(['--label', 'com.example/evil'], 'codex-resets'), /reverse-DNS style/);
  assert.throws(() => buildLaunchdPlist(['--label', 'com..example'], 'codex-resets'), /reverse-DNS style/);
  assert.throws(() => buildLaunchdPlist(['--label', '-com.example'], 'codex-resets'), /reverse-DNS style/);
});
