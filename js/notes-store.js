export const NOTE_CATEGORIES = { essay: '随笔', note: '灵感', log: '学习记录' };
export const NOTES_REPOSITORY = { owner: 'fushengjun2026-cell', name: 'Fusj_lab', branch: 'main', path: 'data/notes.json' };
const API = 'https://api.github.com';
const REPO_PATH = `/repos/${NOTES_REPOSITORY.owner}/${NOTES_REPOSITORY.name}`;
const FILE_PATH = `${REPO_PATH}/contents/${NOTES_REPOSITORY.path}`;

export class NotesError extends Error {
  constructor(message, code = 'unknown') { super(message); this.name = 'NotesError'; this.code = code; }
}

export function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.notes) || value.notes.length > 500) {
    throw new NotesError('笔记数据格式不正确，暂时无法读取或发布。', 'format');
  }
  const ids = new Set();
  const notes = value.notes.map(note => {
    if (!note || typeof note.id !== 'string' || !note.id || note.id.length > 100 || ids.has(note.id)
      || typeof note.title !== 'string' || !note.title.trim() || note.title.length > 120
      || !Object.hasOwn(NOTE_CATEGORIES, note.category)
      || typeof note.content !== 'string' || !note.content.trim() || note.content.length > 50000
      || typeof note.createdAt !== 'string' || !Number.isFinite(Date.parse(note.createdAt))
      || typeof note.updatedAt !== 'string' || !Number.isFinite(Date.parse(note.updatedAt))) {
      throw new NotesError('有一篇笔记的数据不完整。请检查仓库文件，避免覆盖已有内容。', 'format');
    }
    ids.add(note.id);
    return { id: note.id, title: note.title, category: note.category, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt };
  });
  return { version: 1, notes };
}

export function encodeDocument(document) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(validateDocument(document), null, 2)}\n`);
  if (bytes.length > 900000) throw new NotesError('笔记本已接近容量上限，请先缩短部分长文。', 'size');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function decodeDocument(content) {
  try {
    const binary = atob(content.replace(/\s/g, ''));
    return validateDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))));
  } catch (error) {
    if (error instanceof NotesError) throw error;
    throw new NotesError('笔记文件无法读取，请检查仓库里的 data/notes.json。', 'format');
  }
}

function sameNote(a, b) {
  return a === b || (!!a && !!b && ['id', 'title', 'category', 'content', 'createdAt', 'updatedAt'].every(key => a[key] === b[key]));
}

export class GitHubNotesStore {
  #token = '';
  #request;
  #writing = false;
  constructor(request = globalThis.fetch.bind(globalThis)) { this.#request = request; }
  get connected() { return !!this.#token; }
  disconnect() { this.#token = ''; }

  async #api(path, options = {}, token = this.#token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (options.body) headers['Content-Type'] = 'application/json';
      const response = await this.#request(`${API}${path}`, { ...options, headers, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok) {
        if (response.status === 404) throw new NotesError('找不到仓库或笔记文件。请确认令牌允许访问 Fusj_lab。', 'missing');
        if (response.status === 401) throw new NotesError('访问令牌无效或已过期，请重新连接。', 'auth');
        if (response.status === 403 || response.status === 429) {
          const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0';
          throw new NotesError(limited ? 'GitHub 暂时限制了读取次数，请稍后重试。' : '无法执行操作。请检查令牌的 Contents 读写权限和仓库访问范围。', limited ? 'rate' : 'permission');
        }
        if (response.status === 409) throw new NotesError('笔记本刚刚发生变化，请稍后再试。', 'conflict');
        if (response.status === 422) throw new NotesError('GitHub 未接受这次发布，请检查令牌权限或仓库分支限制。', 'validation');
        throw new NotesError('GitHub 暂时无法响应，请稍后重试。', 'network');
      }
      return await response.json();
    } catch (error) {
      if (error instanceof NotesError) throw error;
      throw new NotesError('连接暂时失败，请检查网络后重试。', 'network');
    } finally { clearTimeout(timeout); }
  }

  async connect(credential) {
    const token = credential.trim();
    if (!token) throw new NotesError('请填写访问令牌。', 'auth');
    const user = await this.#api('/user', {}, token);
    if (user.login?.toLowerCase() !== NOTES_REPOSITORY.owner.toLowerCase()) {
      throw new NotesError(`请使用仓库所有者 ${NOTES_REPOSITORY.owner} 的访问令牌。`, 'owner');
    }
    const repo = await this.#api(REPO_PATH, {}, token);
    if (!repo.permissions?.push) throw new NotesError('当前账号没有这个仓库的写入权限。', 'permission');
    if (repo.private) throw new NotesError('当前仓库不是公开仓库，访客无法阅读笔记。', 'permission');
    this.#token = token;
    try { return await this.read(); } catch (error) { this.disconnect(); throw error; }
  }

  async read() {
    let file;
    try { file = await this.#api(`${FILE_PATH}?ref=${NOTES_REPOSITORY.branch}`); }
    catch (error) {
      if (error.code === 'missing') return { document: { version: 1, notes: [] }, sha: null };
      throw error;
    }
    if (file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string') {
      throw new NotesError('笔记文件格式或大小不受支持，暂时无法读取。', 'format');
    }
    return { document: decodeDocument(file.content), sha: file.sha };
  }

  async save(note, expectedNote = null) {
    const validated = validateDocument({ version: 1, notes: [note] }).notes[0];
    return this.#mutate(validated.id, expectedNote, validated);
  }

  async remove(note) { return this.#mutate(note.id, note, null); }

  async #mutate(id, expectedNote, replacement) {
    if (!this.connected) throw new NotesError('请先连接管理账号。', 'auth');
    if (this.#writing) throw new NotesError('上一条笔记还在发布，请稍等。', 'busy');
    this.#writing = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await this.read();
        const remoteNote = current.document.notes.find(note => note.id === id) || null;
        // A timed-out publish may already have succeeded. The stable ID makes retries safe.
        if (sameNote(remoteNote, replacement)) return current;
        if (!sameNote(remoteNote, expectedNote)) {
          throw new NotesError('这篇笔记已在另一台设备上修改或删除。请先复制当前草稿，关闭编辑器，再打开最新笔记合并修改。', 'edited');
        }
        const notes = current.document.notes.filter(note => note.id !== id);
        if (replacement) notes.push(replacement);
        const document = validateDocument({ version: 1, notes });
        const payload = { message: `${replacement ? (expectedNote ? 'Update' : 'Publish') : 'Delete'} note: ${(replacement || expectedNote).title}`, content: encodeDocument(document), branch: NOTES_REPOSITORY.branch };
        if (current.sha) payload.sha = current.sha;
        try {
          const saved = await this.#api(FILE_PATH, { method: 'PUT', body: JSON.stringify(payload) });
          return { document, sha: saved.content?.sha || null };
        } catch (error) {
          if (error.code === 'conflict') continue;
          if (error.code === 'network') {
            try {
              const checked = await this.read();
              if (sameNote(checked.document.notes.find(note => note.id === id) || null, replacement)) return checked;
            } catch { /* Keep the original error and the local draft. */ }
            throw new NotesError('暂时无法确认发布结果。请恢复网络后刷新笔记列表再重试，当前编辑内容仍在编辑器中。', 'network');
          }
          throw error;
        }
      }
      throw new NotesError('笔记本正在被其他设备更新，请稍后再发布。', 'conflict');
    } finally { this.#writing = false; }
  }
}
