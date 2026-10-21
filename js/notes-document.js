export const NOTE_CATEGORIES = { essay: '随笔', note: '灵感', log: '学习记录' };

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
      throw new NotesError('有一篇笔记的数据不完整。请检查笔记数据，避免覆盖已有内容。', 'format');
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
    throw new NotesError('笔记文件无法读取，请检查笔记数据。', 'format');
  }
}

export function sameNote(a, b) {
  return a === b || (!!a && !!b && ['id', 'title', 'category', 'content', 'createdAt', 'updatedAt'].every(key => a[key] === b[key]));
}
