import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageFromCodex, normalizeUsage, mergeUsageActivity } from '../js/usage-data.js';

const children = new Set();
const tracked = child => { children.add(child); child.once('exit', () => children.delete(child)); child.once('error', () => children.delete(child)); return child; };

export const activityDay = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export class DailyUsageCache {
  constructor(path) { this.path = path; this.attemptedDay = null; this.snapshot = null; }
  async load() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      this.snapshot = state.snapshot ? normalizeUsage(state.snapshot) : null;
      this.attemptedDay = typeof state.attemptedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.attemptedDay) ? state.attemptedDay : null;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('本机每日用量缓存无法读取，请检查缓存文件。'); }
    return this;
  }
  async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.tmp';
    await writeFile(temporary, JSON.stringify({ version: 1, attemptedDay: this.attemptedDay, snapshot: this.snapshot }), { mode: 0o600 });
    await chmod(temporary, 0o600); await rename(temporary, this.path);
  }
  async beginActivityRead(now = Date.now()) {
    if (this.attemptedDay === activityDay(now)) return false;
    // Persist before requesting so restarts or a failed response cannot create a retry loop.
    this.attemptedDay = activityDay(now); await this.save(); return true;
  }
  async remember(snapshot) {
    this.snapshot = normalizeUsage({ ...snapshot, activity: mergeUsageActivity(this.snapshot?.activity, snapshot.activity) });
    await this.save(); return this.snapshot;
  }
}

// Only account read methods are used: no conversation, inference, or earned-reset consumption.
export async function readUsage(codexPath = 'codex', { includeActivity = true } = {}) {
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
    if (rates.status === 'rejected') throw rates.reason;
    return usageFromCodex(rates.value, activity.status === 'fulfilled' ? activity.value : null);
  } finally {
    stopped = true; failAll(); lines.close(); child.kill();
  }
}

export function uploadUsage(config, snapshot) {
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
      if (code !== 0) { reject(new Error('用量上传失败，请检查网络与同步授权。')); return; }
      try { const result = JSON.parse(output); if (result.ok !== true) throw new Error(); resolvePromise(result); }
      catch { reject(new Error('用量服务返回了无效响应。')); }
    });
    child.stdin.on('error', () => reject(new Error('用量上传已中断。')));
    child.stdin.end([
      'silent', 'show-error', 'fail-with-body', 'max-time = 25', 'connect-timeout = 10',
      `url = ${JSON.stringify(url.href)}`, 'request = "PUT"',
      'user-agent = "FusjLab-UsageSync/1.0"', 'header = "Content-Type: application/json"',
      `header = "Authorization: Bearer ${config.syncToken}"`,
      `data-binary = ${JSON.stringify(JSON.stringify(snapshot))}`
    ].join('\n') + '\n');
  });
}

async function main() {
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { for (const child of children) child.kill(); process.exit(0); });
  const args = process.argv.slice(2), configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : resolve(homedir(), 'Library/Application Support/FusjLab/codex-usage.json');
  if (args.includes('--read-only')) { console.log(JSON.stringify(await readUsage(process.env.FUSJ_CODEX_PATH || 'codex'))); return; }
  let config; try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { throw new Error('请先配置本机的用量同步文件。'); }
  if (config.proxyUrl) process.env.HTTPS_PROXY = config.proxyUrl;
  const interval = Math.max(60000, Math.min(3600000, (config.intervalSeconds || 60) * 1000));
  const cache = await new DailyUsageCache(configPath + '.cache.json').load();
  let busy = false;
  const cycle = async () => {
    if (busy) return;
    busy = true;
    try {
      const includeActivity = await cache.beginActivityRead();
      const incoming = await readUsage(config.codexPath, { includeActivity });
      if (includeActivity && !mergeUsageActivity(null, incoming.activity)) console.error(new Date().toISOString() + ' 每日统计暂未返回，保留上次记录，下一天再读取。');
      const snapshot = await cache.remember(incoming);
      await uploadUsage(config, snapshot);
      console.log(new Date().toISOString() + ' 额度同步成功；每日统计按北京时间每天读取一次。');
    } catch (error) {
      console.error(new Date().toISOString() + ' ' + error.message);
      if (args.includes('--once')) process.exitCode = 1;
    } finally { busy = false; }
  };
  await cycle();
  if (!args.includes('--once')) setInterval(cycle, interval);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
