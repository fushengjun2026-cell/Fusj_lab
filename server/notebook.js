import { NotesError, validateDocument, encodeDocument, sameNote } from '../js/notes-document.js';
import { CodexUsage } from './codex-usage.js';

const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 1100000;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const hash = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
function equal(a, b) {
  let different = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) different |= (a[i] || 0) ^ (b[i] || 0);
  return different === 0;
}

async function body(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new NotesError('请求格式不正确。', 'format');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new NotesError('请求内容为空。', 'format');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_REQUEST_BYTES) { await reader.cancel(); throw new NotesError('这次发布的内容过长。', 'size'); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof NotesError) throw error;
    throw new NotesError('请求内容无法读取。', 'format');
  } finally { reader.releaseLock(); }
}

// All document changes are synchronous SQLite transactions on one shared notebook.
// Browser-supplied flags never grant permission; every write checks a server session.
export class NotebookService {
  constructor(storage, env, initial = { version: 1, notes: [] }, now = Date.now) {
    this.storage = storage;
    this.sql = storage.sql;
    this.env = env;
    this.now = now;
    this.usage = new CodexUsage(storage, now);
    this.sql.exec('CREATE TABLE IF NOT EXISTS notebook (id INTEGER PRIMARY KEY, document TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, password_tag TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (client TEXT PRIMARY KEY, starts INTEGER NOT NULL, count INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS history (revision INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL, saved_at TEXT NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO notebook (id, document) VALUES (1, ?)', JSON.stringify(validateDocument(initial)));
  }

  snapshot() {
    return { document: validateDocument(JSON.parse(Array.from(this.sql.exec('SELECT document FROM notebook WHERE id = 1'))[0].document)) };
  }

  configured() {
    if (!this.env.NOTES_PASSWORD) throw new NotesError('笔记管理服务尚未完成设置。', 'setup');
  }

  takeLoginAttempt(client) {
    const now = this.now();
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM attempts WHERE starts <= ?', now - 60000);
      for (const [key, limit] of [[`client:${client}`, 5], ['all', 30]]) {
        const row = Array.from(this.sql.exec('SELECT count FROM attempts WHERE client = ?', key))[0];
        if ((row?.count || 0) >= limit) throw new NotesError('尝试次数较多，请一分钟后再试。', 'rate');
      }
      for (const key of [`client:${client}`, 'all']) {
        this.sql.exec('INSERT INTO attempts (client, starts, count) VALUES (?, ?, 1) ON CONFLICT(client) DO UPDATE SET count = count + 1', key, now);
      }
    });
  }

  async authorize(request) {
    this.configured();
    const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) throw new NotesError('请先输入管理密码。', 'auth');
    const tokenHash = hex(await hash(token));
    const tag = hex(await hash(this.env.NOTES_PASSWORD));
    const row = Array.from(this.sql.exec('SELECT expires, password_tag FROM sessions WHERE token_hash = ?', tokenHash))[0];
    if (!row || row.expires <= this.now() || row.password_tag !== tag) {
      this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      throw new NotesError('管理登录已过期，请重新输入密码。', 'auth');
    }
    return tokenHash;
  }

  async login(request) {
    this.configured();
    this.takeLoginAttempt(request.headers.get('x-notes-client') || 'unknown');
    const value = await body(request);
    if (typeof value?.password !== 'string' || !value.password || value.password.length > 256
      || !equal(await hash(value.password), await hash(this.env.NOTES_PASSWORD))) {
      throw new NotesError('密码不正确，请重新输入。', 'password');
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = hex(await hash(token));
    const tag = hex(await hash(this.env.NOTES_PASSWORD));
    const expiresAt = this.now() + SESSION_MS;
    this.sql.exec('DELETE FROM sessions WHERE expires <= ?', this.now());
    this.sql.exec('INSERT INTO sessions (token_hash, expires, password_tag) VALUES (?, ?, ?)', tokenHash, expiresAt, tag);
    return json({ token, expiresAt, ...this.snapshot() });
  }

  mutate(value, remove) {
    if (!value || typeof value !== 'object') throw new NotesError('笔记数据格式不正确。', 'format');
    const expected = value.expected == null ? null : validateDocument({ version: 1, notes: [value.expected] }).notes[0];
    const replacement = remove ? null : validateDocument({ version: 1, notes: [value.note] }).notes[0];
    if (remove && !expected) throw new NotesError('请指定要删除的笔记。', 'format');
    const id = (replacement || expected).id;
    if (expected && expected.id !== id) throw new NotesError('笔记编号不匹配。', 'format');
    if (replacement && expected && replacement.createdAt !== expected.createdAt) throw new NotesError('不能改变笔记的原始发布日期。', 'format');
    return this.storage.transactionSync(() => {
      const current = this.snapshot();
      const remote = current.document.notes.find(note => note.id === id) || null;
      // Retrying a successful request after losing its response is harmless.
      if (sameNote(remote, replacement)) return current;
      if (!sameNote(remote, expected)) throw new NotesError('这篇笔记已被其他人修改或删除。请复制当前草稿，再打开最新笔记合并修改。', 'edited');
      const notes = current.document.notes.filter(note => note.id !== id);
      if (replacement) notes.push(replacement);
      const document = validateDocument({ version: 1, notes });
      encodeDocument(document); // Enforce the same UTF-8 size limit as the browser.
      this.sql.exec('INSERT INTO history (document, saved_at) VALUES (?, ?)', JSON.stringify(current.document), new Date(this.now()).toISOString());
      this.sql.exec('DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50)');
      this.sql.exec('UPDATE notebook SET document = ? WHERE id = 1', JSON.stringify(document));
      return { document };
    });
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname.replace(/\/$/, '');
      if (path === '/api/codex-usage' && request.method === 'GET') {
        await this.authorize(request);
        return json(this.usage.read());
      }
      if (path === '/api/codex-usage/sync' && request.method === 'PUT') {
        if (!this.env.USAGE_SYNC_TOKEN) throw new NotesError('用量同步尚未完成设置。', 'setup');
        const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token || !equal(await hash(token), await hash(this.env.USAGE_SYNC_TOKEN))) throw new NotesError('用量同步授权无效。', 'auth');
        return json(this.usage.save(await body(request)));
      }
      if (path === '/api/notes' && request.method === 'GET') return json(this.snapshot());
      if (path === '/api/session' && request.method === 'POST') return await this.login(request);
      if (path === '/api/session' && request.method === 'GET') { await this.authorize(request); return json(this.snapshot()); }
      if (path === '/api/session' && request.method === 'DELETE') {
        const tokenHash = await this.authorize(request);
        this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
        return json({ ok: true });
      }
      if (path === '/api/notes' && ['PUT', 'DELETE'].includes(request.method)) {
        const value = await body(request);
        await this.authorize(request);
        return json(this.mutate(value, request.method === 'DELETE'));
      }
      if (path === '/api/history' && request.method === 'GET') {
        await this.authorize(request);
        return json({ history: Array.from(this.sql.exec('SELECT revision, document, saved_at FROM history ORDER BY revision DESC')).map(row => ({ ...row, document: JSON.parse(row.document) })) });
      }
      return json({ message: '找不到这个接口。', code: 'missing' }, 404);
    } catch (error) {
      if (error instanceof NotesError) {
        const status = { auth: 401, password: 401, rate: 429, setup: 503, edited: 409, size: 413 }[error.code] || 400;
        return json({ message: error.message, code: error.code }, status);
      }
      return json({ message: '笔记服务暂时无法响应，请稍后重试。', code: 'network' }, 500);
    }
  }
}
