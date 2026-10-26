import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageFromCodex, normalizeUsage, mergeUsageActivity } from '../js/usage-data.js';

const children = new Set();
const tracked = child => { children.add(child); child.once('exit', () => children.delete(child)); child.once('error', () => children.delete(child)); return child; };

export class UsageCache {
  constructor(path) { this.path = path; this.snapshot = null; this.pendingResult = null; }
  async load() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      this.snapshot = state.snapshot ? normalizeUsage(state.snapshot) : null;
      if (state.pendingResult) {
        const item = state.pendingResult;
        if (typeof item.id !== 'string' || typeof item.lease !== 'string' || !['success', 'partial', 'failed'].includes(item.status)) throw new Error();
        this.pendingResult = { id: item.id, lease: item.lease, status: item.status, reason: item.reason === 'rates' ? 'rates' : 'daily', ...(item.snapshot ? { snapshot: normalizeUsage(item.snapshot) } : {}) };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('本机每日用量缓存无法读取，请检查缓存文件。'); }
    return this;
  }
  async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.tmp';
    await writeFile(temporary, JSON.stringify({ version: 2, snapshot: this.snapshot, pendingResult: this.pendingResult }), { mode: 0o600 });
    await chmod(temporary, 0o600); await rename(temporary, this.path);
  }
  async remember(snapshot) {
    this.snapshot = normalizeUsage({ ...snapshot, activity: mergeUsageActivity(this.snapshot?.activity, snapshot.activity) });
    await this.save(); return this.snapshot;
  }
  async stage(request, result) {
    if (result.snapshot) await this.remember(result.snapshot);
    this.pendingResult = { ...request, status: result.status, reason: result.reason, ...(result.snapshot ? { snapshot: this.snapshot } : {}) };
    await this.save();
  }
  async delivered() { this.pendingResult = null; await this.save(); }
}

// Only account read methods are used: no conversation, inference, or earned-reset consumption.
export async function readUsageResult(codexPath = 'codex', { includeActivity = true, previous = null } = {}) {
  const child = tracked(spawn(codexPath, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const lines = createInterface({ input: child.stdout }), pending = new Map();
  let sequence = 0, stopped = false;
  const failAll = () => { for (const item of pending.values()) item.reject(new Error('Codex 读取服务未能正常响应，请确认本机已登录。')); pending.clear(); };
  child.on('error', failAll); child.on('exit', failAll); child.stderr.on('data', () => {});
  child.stdin.on('error', failAll);
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(`Codex 用量接口暂时不可用（${item.method}，${Number.isInteger(message.error.code) ? message.error.code : 'unknown'}）。`));
    else item.resolve(message.result);
  });
  const send = value => { if (!stopped) child.stdin.write(JSON.stringify(value) + '\n'); };
  const request = (method, params = {}, timeout = 25000) => new Promise((resolvePromise, rejectPromise) => {
    const id = sequence++, timer = setTimeout(() => { pending.delete(id); rejectPromise(new Error('Codex 用量读取超时。')); }, timeout);
    const finish = callback => value => { clearTimeout(timer); callback(value); };
    pending.set(id, { method, resolve: finish(resolvePromise), reject: finish(rejectPromise) }); send({ method, params, id });
  });
  try {
    await request('initialize', { clientInfo: { name: 'fusj_usage_reader', title: 'FusjLab usage reader', version: '1.0.0' } });
    send({ method: 'initialized', params: {} });
    const [rates, activity] = await Promise.allSettled([request('account/rateLimits/read'), includeActivity ? request('account/usage/read') : Promise.resolve(null)]);
    const now = Date.now();
    let quotas = null, activityData = null;
    const diagnostics = [];
    for (const reply of [rates, activity]) if (reply.status === 'rejected') diagnostics.push(reply.reason.message);
    try { if (rates.status === 'fulfilled') quotas = usageFromCodex(rates.value, null, now); } catch (error) { diagnostics.push('额度数据：' + error.message); }
    try { if (activity.status === 'fulfilled' && activity.value) activityData = mergeUsageActivity(null, usageFromCodex({ rateLimits: { limitId: 'codex' } }, activity.value, now).activity); } catch (error) { diagnostics.push('每日统计数据：' + error.message); }
    if (!quotas && !activityData) return { status: 'failed', reason: 'all', snapshot: null, diagnostics };
    const base = quotas || previous || { version: 1, limits: [{ id: 'codex' }], resetsAvailable: null };
    const snapshot = normalizeUsage({ ...base, sampledAt: new Date(now).toISOString(), limitsSampledAt: quotas?.sampledAt ?? previous?.limitsSampledAt ?? null, activity: mergeUsageActivity(previous?.activity, activityData) });
    const dailyReturned = activityData?.daily?.some(row => row.tokens != null);
    return { snapshot, status: quotas && (dailyReturned || !includeActivity) ? 'success' : 'partial', reason: quotas ? 'daily' : 'rates', diagnostics };
  } finally {
    stopped = true; failAll(); lines.close(); child.kill();
  }
}
export async function readUsage(codexPath = 'codex', options = {}) {
  const result = await readUsageResult(codexPath, options);
  if (!result.snapshot) throw new Error('账号接口暂未返回可用的用量数据。');
  return result.snapshot;
}

export function syncRequest(config, path, method = 'POST', data = {}) {
  if (!['/api/codex-usage/sync', '/api/codex-usage/refresh/claim', '/api/codex-usage/refresh/complete'].includes(path)) throw new Error('用量接口不正确。');
  const url = new URL(config.syncUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/codex-usage/sync' || !/^[a-f0-9]{64}$/.test(config.syncToken)) throw new Error('用量同步设置不正确。');
  return new Promise((resolvePromise, reject) => {
    // curl reads its credential and request body from stdin, never process arguments or logs.
    const child = tracked(spawn('/usr/bin/curl', ['--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] }));
    let output = '';
    child.stdout.on('data', chunk => { if (output.length < 65536) output += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('无法启动用量上传。')));
    child.on('exit', code => {
      if (code !== 0) {
        let reason; try { reason = JSON.parse(output).code; } catch {}
        const error = new Error('用量服务连接失败，请检查网络与同步授权。');
        error.code = ['edited', 'format', 'auth'].includes(reason) ? reason : 'network'; reject(error); return;
      }
      try { resolvePromise(JSON.parse(output)); }
      catch { reject(new Error('用量服务返回了无效响应。')); }
    });
    child.stdin.on('error', () => reject(new Error('用量上传已中断。')));
    child.stdin.end([
      'silent', 'show-error', 'fail-with-body', 'max-time = 25', 'connect-timeout = 10',
      `url = ${JSON.stringify(new URL(path, url.origin).href)}`, `request = ${JSON.stringify(method)}`,
      'user-agent = "FusjLab-UsageSync/1.0"', 'header = "Content-Type: application/json"',
      `header = "Authorization: Bearer ${config.syncToken}"`,
      `data-binary = ${JSON.stringify(JSON.stringify(data))}`
    ].join('\n') + '\n');
  });
}
export function uploadUsage(config, snapshot) { return syncRequest(config, '/api/codex-usage/sync', 'PUT', snapshot); }

export async function processRefresh(cache, config, { request = syncRequest, read = readUsageResult } = {}) {
  // Retrying delivery never re-reads the account, including after a process restart.
  if (!cache.pendingResult) {
    const claim = await request(config, '/api/codex-usage/refresh/claim');
    if (!claim.request) return 'idle';
    let result;
    try { result = await read(config.codexPath, { previous: cache.snapshot }); }
    catch { result = { status: 'failed', reason: 'all', snapshot: null }; }
    for (const detail of result.diagnostics || []) console.error(new Date().toISOString() + ' ' + detail);
    await cache.stage(claim.request, result);
  }
  try {
    await request(config, '/api/codex-usage/refresh/complete', 'PUT', cache.pendingResult);
    const status = cache.pendingResult.status; await cache.delivered(); return status;
  } catch (error) {
    if (['edited', 'format'].includes(error.code)) { await cache.delivered(); return 'expired'; }
    throw error;
  }
}

async function main() {
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { for (const child of children) child.kill(); process.exit(0); });
  const args = process.argv.slice(2), configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : resolve(homedir(), 'Library/Application Support/FusjLab/codex-usage.json');
  if (args.includes('--read-only')) { console.log(JSON.stringify(await readUsage(process.env.FUSJ_CODEX_PATH || 'codex'))); return; }
  let config; try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { throw new Error('请先配置本机的用量同步文件。'); }
  if (config.proxyUrl) process.env.HTTPS_PROXY = config.proxyUrl;
  const interval = Math.max(5000, Math.min(30000, (config.pollSeconds || 5) * 1000));
  const cache = await new UsageCache(configPath + '.cache.json').load();
  let busy = false;
  const cycle = async () => {
    if (busy) return;
    busy = true;
    try {
      const status = await processRefresh(cache, config);
      if (status !== 'idle') console.log(new Date().toISOString() + ' 手动刷新处理结果：' + status);
    } catch (error) {
      console.error(new Date().toISOString() + ' ' + error.message);
      if (args.includes('--once')) process.exitCode = 1;
    } finally { busy = false; }
  };
  await cycle();
  if (!args.includes('--once')) setInterval(cycle, interval);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
