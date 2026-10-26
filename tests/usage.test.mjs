import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsage, usageFromCodex, quotaView, mergeUsageActivity } from '../js/usage-data.js';
import { UsageCache, processRefresh, readUsage, readUsageResult } from '../tools/codex-usage-sync.mjs';
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
test('Partial or absent activity keeps known daily values, zeros, summary fields and the last successful timestamp', () => {
  const now = Date.now(), previous = normalizeUsage(sample(now)).activity;
  assert.deepEqual(mergeUsageActivity(previous, null), previous);
  const empty = normalizeUsage({ ...sample(now + 1000), activity: { summary: {}, daily: [] } }).activity;
  assert.deepEqual(mergeUsageActivity(previous, empty), previous);
  const partial = normalizeUsage({ ...sample(now + 1000), activity: { summary: { currentStreakDays: 8 }, daily: [{ date: '2026-10-21', tokens: null }, { date: '2026-10-22', tokens: 12500 }] } }).activity;
  const merged = mergeUsageActivity(previous, partial);
  assert.equal(merged.summary.lifetimeTokens, 1234567);
  assert.equal(merged.summary.currentStreakDays, 8);
  assert.deepEqual(merged.daily, [{ date: '2026-10-21', tokens: 0 }, { date: '2026-10-22', tokens: 12500 }]);
  assert.deepEqual(mergeUsageActivity(merged, previous), merged);
  const bad = sample(now); bad.activity.sampledAt = new Date(now + 180000).toISOString();
  assert.throws(() => normalizeUsage(bad), /每日统计时间/);
});
test('Fresh quota uploads cannot erase previous activity or relabel its timestamp as freshly fetched', async () => {
  const f = fixture(), owner = await f.login(), token = f.env.USAGE_SYNC_TOKEN;
  await f.call('codex-usage/sync', 'PUT', sample(f.now), token);
  const initial = (await (await f.call('codex-usage', 'GET', undefined, owner)).json()).snapshot;
  f.advance(60000);
  const ratesOnly = sample(f.now); ratesOnly.activity = null; ratesOnly.limits[0].primary.usedPercent = 25;
  assert.equal((await f.call('codex-usage/sync', 'PUT', ratesOnly, token)).status, 200);
  f.restart();
  const updated = (await (await f.call('codex-usage', 'GET', undefined, owner)).json()).snapshot;
  assert.equal(updated.limits[0].primary.usedPercent, 25);
  assert.equal(updated.sampledAt, ratesOnly.sampledAt);
  assert.deepEqual(updated.activity, initial.activity);
});
test('Idle and restarted agents never read the account; failed delivery retries the saved result without reading again', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'fusj-usage-manual-'));
  try {
    const path = join(folder, 'cache.json');
    const cache = await new UsageCache(path).load();
    let reads = 0, failDelivery = true, pending = null;
    const request = async (config, endpoint) => {
      if (endpoint.endsWith('/claim')) { const next = pending; pending = null; return { request: next }; }
      if (failDelivery) throw new Error('network');
      return { ok: true };
    };
    const read = async () => { reads++; return { status: 'success', snapshot: normalizeUsage(sample()) }; };
    const options = { request, read };
    for (let i = 0; i < 5; i++) assert.equal(await processRefresh(cache, {}, options), 'idle');
    assert.equal(reads, 0);
    pending = { id: 'first-click', lease: 'first-lease' };
    await assert.rejects(processRefresh(cache, {}, options), /network/);
    assert.equal(reads, 1);
    const restarted = await new UsageCache(path).load();
    failDelivery = false;
    assert.equal(await processRefresh(restarted, {}, options), 'success');
    assert.equal(reads, 1);
    assert.equal(restarted.pendingResult, null);
    assert.equal(await processRefresh(restarted, {}, options), 'idle');
    pending = { id: 'second-click', lease: 'second-lease' };
    assert.equal(await processRefresh(restarted, {}, options), 'success');
    assert.equal(reads, 2, 'every new manual click reads again, with no daily gate');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('Manual refresh queue requires owner authorization, coalesces active clicks and only allows one agent to claim it', async () => {
  const f = fixture(), owner = await f.login(), token = f.env.USAGE_SYNC_TOKEN;
  assert.equal((await f.call('codex-usage/refresh', 'POST')).status, 401);
  assert.equal((await f.call('codex-usage/refresh', 'POST', undefined, token)).status, 401);
  assert.equal((await f.call('codex-usage/refresh/claim', 'POST', undefined, owner)).status, 401);
  const created = await (await f.call('codex-usage/refresh', 'POST', undefined, owner)).json();
  const repeated = await (await f.call('codex-usage/refresh', 'POST', undefined, owner)).json();
  assert.equal(created.refresh.id, repeated.refresh.id);
  f.restart();
  const claimed = await (await f.call('codex-usage/refresh/claim', 'POST', undefined, token)).json();
  assert.deepEqual(Object.keys(claimed.request).sort(), ['id', 'lease']);
  assert.equal(claimed.request.id, created.refresh.id);
  assert.equal((await (await f.call('codex-usage/refresh/claim', 'POST', undefined, token)).json()).request, null);
  const privateRead = await (await f.call('codex-usage', 'GET', undefined, owner)).json();
  assert.equal(privateRead.refresh.lease, undefined);
  const result = { ...claimed.request, status: 'success', snapshot: sample(f.now) };
  assert.equal((await f.call('codex-usage/refresh/complete', 'PUT', { ...result, lease: 'forged' }, token)).status, 409);
  assert.equal((await f.call('codex-usage/refresh/complete', 'PUT', result, owner)).status, 401);
  assert.equal((await f.call('codex-usage/refresh/complete', 'PUT', result, token)).status, 200);
  assert.equal((await f.call('codex-usage/refresh/complete', 'PUT', result, token)).status, 200, 'lost completion receipts can safely be retried');
  const completed = await (await f.call('codex-usage', 'GET', undefined, owner)).json();
  assert.equal(completed.refresh.status, 'success');
  assert.equal(completed.snapshot.activity.daily[0].tokens, 0);
  const next = await (await f.call('codex-usage/refresh', 'POST', undefined, owner)).json();
  assert.notEqual(next.refresh.id, completed.refresh.id);
});
test('Offline requests expire visibly and failed reads preserve old statistics and timestamps', async () => {
  const f = fixture(), owner = await f.login(), token = f.env.USAGE_SYNC_TOKEN;
  await f.call('codex-usage/sync', 'PUT', sample(f.now), token);
  const before = (await (await f.call('codex-usage', 'GET', undefined, owner)).json()).snapshot;
  await f.call('codex-usage/refresh', 'POST', undefined, owner);
  f.advance(120001);
  let result = await (await f.call('codex-usage', 'GET', undefined, owner)).json();
  assert.equal(result.refresh.status, 'failed'); assert.match(result.refresh.message, /电脑/);
  assert.deepEqual(result.snapshot, before);
  assert.equal((await (await f.call('codex-usage/refresh/claim', 'POST', undefined, token)).json()).request, null);
  await f.call('codex-usage/refresh', 'POST', undefined, owner);
  const claim = await (await f.call('codex-usage/refresh/claim', 'POST', undefined, token)).json();
  await f.call('codex-usage/refresh/complete', 'PUT', { ...claim.request, status: 'failed' }, token);
  result = await (await f.call('codex-usage', 'GET', undefined, owner)).json();
  assert.deepEqual(result.snapshot, before);
  assert.match(result.refresh.message, /账号接口/);
});
test('Quota-only cycles send no account/usage/read request; daily cycles explicitly opt in', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'fusj-usage-reader-'));
  try {
    const script = join(folder, 'mock-codex.mjs'), log = join(folder, 'methods.log');
    await writeFile(script, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nimport {appendFileSync} from 'node:fs';\nfor await (const line of createInterface({input:process.stdin})) {\n const request=JSON.parse(line);\n appendFileSync(${JSON.stringify(log)},request.method+'\\n');\n if(request.id==null)continue;\n const result=request.method==='account/rateLimits/read'?{rateLimits:{limitId:'codex',primary:{usedPercent:12}}}:request.method==='account/usage/read'?{summary:{lifetimeTokens:10000},dailyUsageBuckets:[{startDate:'2026-10-22',tokens:10000}]}:{};\n process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');\n}\n`, { mode: 0o700 });
    const ratesOnly = await readUsage(script, { includeActivity: false });
    assert.equal(ratesOnly.activity, null);
    assert.equal((await readFile(log, 'utf8')).includes('account/usage/read'), false);
    const full = await readUsage(script, { includeActivity: true });
    assert.equal(full.activity.daily[0].tokens, 10000);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'account/usage/read').length, 1);
    const source = await readFile(script, 'utf8');
    const previous = normalizeUsage(sample(Date.now() - 3600000));
    const fail = method => source.replace("const result=request.method===", `if(request.method===${JSON.stringify(method)}){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32603}})+'\\n');continue;}\n const result=request.method===`);
    await writeFile(script, fail('account/rateLimits/read'));
    const dailyOnly = await readUsageResult(script, { previous });
    assert.equal(dailyOnly.status, 'partial'); assert.equal(dailyOnly.reason, 'rates');
    assert.equal(dailyOnly.snapshot.limitsSampledAt, previous.limitsSampledAt);
    assert(dailyOnly.snapshot.activity.dailySampledAt > previous.activity.dailySampledAt);
    await writeFile(script, fail('account/usage/read'));
    const quotaOnly = await readUsageResult(script, { previous });
    assert.equal(quotaOnly.status, 'partial'); assert.equal(quotaOnly.reason, 'daily');
    assert.equal(quotaOnly.snapshot.activity.dailySampledAt, previous.activity.dailySampledAt);
    assert(quotaOnly.snapshot.limitsSampledAt > previous.limitsSampledAt);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
