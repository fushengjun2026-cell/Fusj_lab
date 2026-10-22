import { NotesError, validateDocument, sameNote } from './notes-document.js';
export { NOTE_CATEGORIES, NotesError, validateDocument } from './notes-document.js';

export class PasswordNotesStore {
  #token = '';
  #request;
  #storage;
  #base;
  #writing = false;
  constructor(base, { request = globalThis.fetch.bind(globalThis), storage = null } = {}) {
    this.#base = base.replace(/\/$/, '');
    if (this.#base) {
      const url = new URL(this.#base);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
        throw new NotesError('管理服务必须通过 HTTPS 连接。', 'setup');
      }
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new NotesError('管理服务地址不正确。', 'setup');
    }
    this.#request = request;
    this.#storage = storage;
  }
  get connected() { return !!this.#token; }
  get configured() { return !!this.#base; }
  get sessionKey() { return `fusj.notes.session.v2:${this.#base}`; }
  #clear() {
    this.#token = '';
    try { this.#storage?.removeItem(this.sessionKey); } catch {}
  }
  disconnect() {
    const token = this.#token;
    this.#clear();
    if (token) return this.#api('/api/session', { method: 'DELETE' }, token).catch(() => {});
    return Promise.resolve();
  }
  async #api(path, options = {}, token = this.#token) {
    if (!this.configured) throw new NotesError('密码管理服务正在接入，完成后即可使用。', 'setup');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (options.body) headers['Content-Type'] = 'application/json';
      const response = await this.#request(`${this.#base}${path}`, { ...options, headers, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 && token === this.#token) this.#clear();
        throw new NotesError(result.message || '暂时无法完成操作，请稍后重试。', result.code || 'network');
      }
      return result;
    } catch (error) {
      if (error instanceof NotesError) throw error;
      throw new NotesError('连接暂时失败，请检查网络后重试。', 'network');
    } finally { clearTimeout(timeout); }
  }
  async connect(password) {
    if (!password) throw new NotesError('请输入管理密码。', 'password');
    const result = await this.#api('/api/session', { method: 'POST', body: JSON.stringify({ password }) }, '');
    const document = validateDocument(result.document);
    if (!/^[a-f0-9]{64}$/.test(result.token) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) {
      throw new NotesError('管理服务返回了无效的登录信息。', 'format');
    }
    this.#token = result.token;
    try { this.#storage?.setItem(this.sessionKey, JSON.stringify({ token: result.token, expiresAt: result.expiresAt })); } catch {}
    return { document };
  }
  async restore() {
    let session;
    try { session = JSON.parse(this.#storage?.getItem(this.sessionKey) || 'null'); } catch {}
    if (!session || !/^[a-f0-9]{64}$/.test(session.token) || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) { this.#clear(); return null; }
    try {
      const result = await this.#api('/api/session', {}, session.token);
      const document = validateDocument(result.document);
      this.#token = session.token;
      return { document };
    } catch (error) {
      if (error.code === 'auth') this.#clear();
      throw error;
    }
  }
  async read() {
    const result = await this.#api('/api/notes', {}, '');
    return { document: validateDocument(result.document) };
  }
  async readUsage() {
    if (!this.connected) throw new NotesError('请先输入管理密码。', 'auth');
    return this.#api('/api/codex-usage');
  }
  async save(note, expected = null) {
    const validated = validateDocument({ version: 1, notes: [note] }).notes[0];
    return this.#mutate(validated.id, validated, expected, 'PUT');
  }
  async remove(note) {
    const validated = validateDocument({ version: 1, notes: [note] }).notes[0];
    return this.#mutate(note.id, null, validated, 'DELETE');
  }
  async #mutate(id, note, expected, method) {
    if (!this.connected) throw new NotesError('请先输入管理密码。', 'auth');
    if (this.#writing) throw new NotesError('上一条笔记还在发布，请稍等。', 'busy');
    this.#writing = true;
    try {
      const result = await this.#api('/api/notes', { method, body: JSON.stringify({ note, expected }) });
      return { document: validateDocument(result.document) };
    } catch (error) {
      if (error.code === 'network') {
        try {
          const current = await this.read();
          if (sameNote(current.document.notes.find(item => item.id === id) || null, note)) return current;
        } catch {}
        throw new NotesError('暂时无法确认发布结果。请恢复网络后刷新笔记再重试，当前草稿仍会保留。', 'network');
      }
      throw error;
    } finally { this.#writing = false; }
  }
}
