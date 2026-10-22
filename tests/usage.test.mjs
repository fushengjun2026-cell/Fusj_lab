import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeUsage, usageFromCodex, quotaView } from '../js/usage-data.js';
import { NotebookService } from '../server/notebook.js';

function sample(now = Date.now()) {
  return { version: 1, sampledAt: new Date(now).toISOString(), limits: [{ id: 'codex', plan: 'plus', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 }, secondary: { usedPercent: 65, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 7200 }, credits: { balance: '42.123', hasCredits: true, unlimited: false } }], resetsAvailable: 2, activity: { summary: { lifetimeTokens: 1234567 }, daily: [{ date: '2026-10-21', tokens: 0 }, { date: '2026-10-22', tokens: null }] } };
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(query, ...args) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...args); statement.run(...args); return []; } }, transactionSync(callback) { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  const env = { NOTES_PASSWORD: 'usage-test-password', USAGE_SYNC_TOKEN: 'a'.repeat(64) };
  let now = Date.now(), service = new NotebookService(storage, env, { version: 1, notes: [] }, () => now);
  const call = (path, method = 'GET', data, token) => service.fetch(new Request('https://fixture.test/api/' + path, { method, headers: { 'x-notes-client': 'usage-test', ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }));
  const login = async () => (await (await call('session', 'POST', { password: env.NOTES_PASSWORD })).json()).token;
  return { env, call, login, get now() { return now; }, advance(ms) { now += ms; }, restart() { service = new NotebookService(storage, env, undefined, () => now); } };
}

test('Quota windows keep zero and unknown distinct; expired windows never invent a new remaining allowance', () => {
  const now = Date.now(), original = sample(now);
  assert.equal(quotaView(original.limits[0].primary, now).remaining, 100);
  assert.equal(quotaView({ usedPercent: null, resetsAt: null }, now).remaining, null);
  assert.equal(quotaView({ usedPercent: 130, resetsAt: null }, now).remaining, 0);
  assert.deepEqual(quotaView({ usedPercent: 75, resetsAt: now / 1000 - 1 }, now), { remaining: null, expired: true });
});
test('Only selected statistical fields survive ingestion, including no account IDs, tokens or conversation contents', () => {
  const input = sample(); input.accountId = 'private-account'; input.accessToken = 'secret'; input.limits[0].email = 'private@example.com'; input.activity.messages = ['private conversation'];
  const result = normalizeUsage(input), encoded = JSON.stringify(result);
  for (const secret of ['private-account', 'secret', 'private@example.com', 'private conversation']) assert.equal(encoded.includes(secret), false);
  assert.equal(result.activity.daily[0].tokens, 0); assert.equal(result.activity.daily[1].tokens, null); assert.equal(result.activity.summary.peakDailyTokens, null);
});
test('Codex extraction prefers all current buckets, supports legacy replies, and leaves unavailable activity unknown', () => {
  const rates = { rateLimits: { limitId: 'old' }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 18 }, planType: 'plus' }, other: { limitName: 'Other bucket', secondary: { usedPercent: 30 } } }, rateLimitResetCredits: { availableCount: 3 } };
  const result = usageFromCodex(rates, null);
  assert.deepEqual(result.limits.map(item => item.id), ['codex', 'other']); assert.equal(result.activity, null); assert.equal(result.resetsAvailable, 3);
  assert.equal(usageFromCodex({ rateLimits: { limitId: 'codex', primary: { usedPercent: 12 } } }, null).limits[0].primary.usedPercent, 12);
});
test('Malformed numbers, invalid dates, duplicate buckets and repeated dates are rejected', () => {
  const original = sample();
  for (const value of [-1, '10', NaN, Infinity]) { const changed = structuredClone(original); changed.limits[0].primary.usedPercent = value; assert.throws(() => normalizeUsage(changed)); }
  const duplicate = structuredClone(original); duplicate.limits.push(duplicate.limits[0]); assert.throws(() => normalizeUsage(duplicate));
  const badDate = structuredClone(original); badDate.activity.daily[0].date = '2026-02-30'; assert.throws(() => normalizeUsage(badDate));
  const duplicateDay = structuredClone(original); duplicateDay.activity.daily.push(duplicateDay.activity.daily[0]); assert.throws(() => normalizeUsage(duplicateDay));
});
test('Usage is private; management sessions and ingest credentials have separate read and write capabilities', async () => {
  const f = fixture(), owner = await f.login();
  assert.equal((await f.call('codex-usage')).status, 401);
  assert.equal((await f.call('codex-usage', 'GET', undefined, f.env.USAGE_SYNC_TOKEN)).status, 401);
  assert.equal((await f.call('codex-usage/sync', 'PUT', sample(f.now), owner)).status, 401);
  assert.equal((await f.call('codex-usage/sync', 'PUT', sample(f.now), 'b'.repeat(64))).status, 401);
  assert.equal((await f.call('codex-usage/sync', 'PUT', sample(f.now), f.env.USAGE_SYNC_TOKEN)).status, 200);
  const result = await (await f.call('codex-usage', 'GET', undefined, owner)).json();
  assert.equal(result.snapshot.limits[0].secondary.usedPercent, 65);
  assert.deepEqual(await (await f.call('notes')).json(), { document: { version: 1, notes: [] } });
  f.restart();
  assert.equal((await (await f.call('codex-usage', 'GET', undefined, owner)).json()).snapshot.activity.summary.lifetimeTokens, 1234567);
});
test('Malformed, late and impossible-clock updates leave the latest good snapshot intact', async () => {
  const f = fixture(), owner = await f.login(), token = f.env.USAGE_SYNC_TOKEN;
  await f.call('codex-usage/sync', 'PUT', sample(f.now), token);
  const before = await (await f.call('codex-usage', 'GET', undefined, owner)).json();
  const invalid = sample(f.now); invalid.limits[0].primary.usedPercent = 'bad';
  assert.equal((await f.call('codex-usage/sync', 'PUT', invalid, token)).status, 400);
  assert.equal((await f.call('codex-usage/sync', 'PUT', sample(f.now - 1000), token)).status, 409);
  assert.equal((await f.call('codex-usage/sync', 'PUT', sample(f.now + 180000), token)).status, 400);
  assert.deepEqual(await (await f.call('codex-usage', 'GET', undefined, owner)).json(), before);
});
test('Missing sync setup fails closed and expired or logged-out management sessions cannot read usage', async () => {
  const f = fixture(), owner = await f.login(); delete f.env.USAGE_SYNC_TOKEN;
  assert.equal((await f.call('codex-usage/sync', 'PUT', sample(f.now), 'a'.repeat(64))).status, 503);
  f.advance(86400001);
  assert.equal((await f.call('codex-usage', 'GET', undefined, owner)).status, 401);
  const renewed = await f.login();
  await f.call('session', 'DELETE', undefined, renewed);
  assert.equal((await f.call('codex-usage', 'GET', undefined, renewed)).status, 401);
});
