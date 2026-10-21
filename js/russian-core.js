export const ROOM_KEY = 'fusj.russian.room.v1';
export const LEVELS = ['review', 'mastered'];
const MAX_BYTES = 3500000;
const badIds = new Set(['__proto__', 'constructor', 'prototype']);
export class RoomError extends Error { constructor(message, code = 'format') { super(message); this.code = code; } }
const fail = message => { throw new RoomError(message); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !badIds.has(value);
const field = (value, max, name, required = false) => {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name}为空或过长，请检查后重试。`);
  return value.trim();
};
export const newId = () => crypto.randomUUID();

export function normalizeRussian(value) {
  const accents = { á: 'а́', Á: 'А́', é: 'е́', É: 'Е́', ó: 'о́', Ó: 'О́', ú: 'у́', Ú: 'У́', ý: 'ы́', Ý: 'Ы́' };
  return value.normalize('NFC').replace(/[\p{L}\p{M}]+/gu, token => /[\u0400-\u04ff]/u.test(token) ? token.replace(/[áÁéÉóÓúÚýÝ]/g, char => accents[char]) : token).normalize('NFC');
}
export const speechText = value => normalizeRussian(value).normalize('NFD').replace(/\u0301/g, '').normalize('NFC');
export function transliterate(value) {
  const letters = { а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z', и:'i', й:'y', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ъ:'ʺ', ы:'y', ь:'ʹ', э:'e', ю:'yu', я:'ya' };
  return Array.from(normalizeRussian(value), char => {
    const result = letters[char.toLowerCase()];
    return result ? (char === char.toUpperCase() ? result[0].toUpperCase() + result.slice(1) : result) : char;
  }).join('');
}
export function splitSentences(value, language = 'ru') {
  return value.split(/\n+/).flatMap(line => {
    if (typeof Intl.Segmenter === 'function') return Array.from(new Intl.Segmenter(language, { granularity: 'sentence' }).segment(line), item => item.segment.trim()).filter(Boolean);
    return (line.match(/[^.!?。！？]+(?:[.!?。！？]+[»”"]*|$)/gu) || []).map(item => item.trim()).filter(Boolean);
  });
}

export function parsePassage(value, previous = []) {
  if (typeof value !== 'string' || !value.trim() || value.length > 60000) fail('请粘贴俄语课文，每次最多 60,000 个字符。');
  const old = new Map();
  for (const sentence of previous) {
    const key = `${sentence.speaker}\0${sentence.text}`;
    if (!old.has(key)) old.set(key, []);
    old.get(key).push(sentence);
  }
  const sentences = [], warnings = [];
  let title = '';
  const lines = value.trim().split(/\n+/).map(line => line.trim()).filter(Boolean);
  for (const [lineIndex, raw] of lines.entries()) {
    let text = normalizeRussian(raw), translation = '', speaker = '';
    const pair = text.match(/\s*[（(]([^()（）]*[\u3400-\u9fff][^()（）]*)[)）]\s*$/u);
    if (pair) { translation = pair[1].trim(); text = text.slice(0, pair.index).trim(); }
    const turn = text.match(/^([^:：]{1,45})[:：]\s*(.+)$/u);
    if (turn) { speaker = turn[1].trim(); text = turn[2].trim(); }
    if (lineIndex === 0 && lines.length > 1 && !speaker && translation && !/[.!?]/.test(text) && text === text.toUpperCase()) {
      title = translation; continue;
    }
    if (!/[\u0400-\u04ff]/u.test(text)) { warnings.push(`第 ${lineIndex + 1} 行没有俄语，未加入练习。`); continue; }
    const chunks = splitSentences(text);
    const meanings = translation ? splitSentences(translation, 'zh') : [];
    const aligned = meanings.length === chunks.length;
    if (translation && !aligned && chunks.length > 1) warnings.push(`第 ${lineIndex + 1} 行的中俄句数不同：整段释义保留在第一句，请手动核对。`);
    chunks.forEach((chunk, index) => {
      const existing = old.get(`${speaker}\0${chunk}`)?.shift();
      sentences.push(existing ? { ...structuredClone(existing), translation: existing.translation || (aligned ? meanings[index] : index === 0 ? translation : '') } : { id: newId(), text: chunk, speaker, pronunciation: '', translation: aligned ? meanings[index] : index === 0 ? translation : '', keywords: [] });
    });
  }
  if (!sentences.length) fail('没有找到可练习的俄语句子，请检查原文。');
  if (sentences.length > 500) fail('每篇课文最多 500 句，请分成几篇导入。');
  return { title, sentences, warnings };
}

export function validateLesson(raw) {
  if (!raw || typeof raw !== 'object' || !id(raw.id)) fail('课文编号无效。');
  if (!Array.isArray(raw.sentences) || !raw.sentences.length || raw.sentences.length > 500) fail('课文需要有 1–500 个句子。');
  const seen = new Set();
  const sentences = raw.sentences.map(sentence => {
    if (!sentence || !id(sentence.id) || seen.has(sentence.id)) fail('句子编号无效或重复。');
    seen.add(sentence.id);
    if (!Array.isArray(sentence.keywords) || sentence.keywords.length > 20) fail('每句最多添加 20 个关键词。');
    const text = normalizeRussian(field(sentence.text, 2000, '俄语原文', true));
    if (!/[\u0400-\u04ff]/u.test(text)) fail('每句原文中需要包含俄语文字。');
    return { id: sentence.id, text, speaker: field(sentence.speaker, 50, '角色'), pronunciation: normalizeRussian(field(sentence.pronunciation, 2000, '读音提示')), translation: field(sentence.translation, 2000, '中文释义'), keywords: sentence.keywords.map(word => normalizeRussian(field(word, 100, '关键词', true))) };
  });
  const vocabulary = raw.vocabulary ?? [];
  if (!Array.isArray(vocabulary) || vocabulary.length > 1000) fail('每篇课文最多收录 1,000 个词条。');
  const words = new Set();
  return {
    id: raw.id, title: field(raw.title, 120, '课文标题', true), subtitle: field(raw.subtitle, 160, '课文副标题'), sentences,
    vocabulary: vocabulary.map(word => {
      if (!word || !id(word.id) || words.has(word.id)) fail('词汇编号无效或重复。');
      words.add(word.id);
      return { id: word.id, word: normalizeRussian(field(word.word, 120, '俄语词汇', true)), pronunciation: normalizeRussian(field(word.pronunciation, 200, '重音或读音')), meaning: field(word.meaning, 400, '中文词义', true), example: normalizeRussian(field(word.example, 2000, '俄语例句')), exampleTranslation: field(word.exampleTranslation, 2000, '例句释义') };
    })
  };
}
const wordSignature = word => `${word.word}\n${word.meaning}`;
export function validateState(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.lessons) || !raw.lessons.length || raw.lessons.length > 50) fail('备份格式不正确，或课文数量超过 50 篇。');
  const lessons = raw.lessons.map(validateLesson);
  if (new Set(lessons.map(lesson => lesson.id)).size !== lessons.length) fail('课文编号重复。');
  const progress = {}, cursors = {};
  for (const lesson of lessons) {
    const source = raw.progress?.[lesson.id];
    const item = { sentences: {}, words: {} };
    for (const [collection, records] of [['sentences', lesson.sentences], ['words', lesson.vocabulary]]) {
      for (const record of records) {
        const saved = source?.[collection]?.[record.id];
        const signature = collection === 'sentences' ? record.text : wordSignature(record);
        if (saved && LEVELS.includes(saved.status) && saved.signature === signature && typeof saved.updatedAt === 'string' && Number.isFinite(Date.parse(saved.updatedAt))) {
          item[collection][record.id] = { status: saved.status, signature, updatedAt: saved.updatedAt };
        }
      }
    }
    progress[lesson.id] = item;
    if (lesson.sentences.some(sentence => sentence.id === raw.cursors?.[lesson.id])) cursors[lesson.id] = raw.cursors[lesson.id];
  }
  const result = { version: 1, lessons, progress, cursors, selectedLessonId: lessons.some(lesson => lesson.id === raw.selectedLessonId) ? raw.selectedLessonId : lessons[0].id };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) fail('课文库过大，请先导出备份，并减少较长的内容。');
  return result;
}

export function mergeBackup(state, raw) {
  if (raw?.format !== 'fusj-russian-room') fail('这不是俄语练习室导出的备份文件。');
  const incoming = validateState(raw);
  const next = structuredClone(state), ids = new Set(state.lessons.map(lesson => lesson.id));
  let firstId;
  for (const lesson of incoming.lessons) {
    const oldId = lesson.id;
    if (ids.has(lesson.id)) { lesson.id = newId(); lesson.title = `${lesson.title.slice(0,110)}（导入）`; }
    ids.add(lesson.id);
    firstId ||= lesson.id;
    next.lessons.push(lesson);
    next.progress[lesson.id] = incoming.progress[oldId];
    if (incoming.cursors[oldId]) next.cursors[lesson.id] = incoming.cursors[oldId];
  }
  next.selectedLessonId = firstId;
  return validateState(next);
}
export function progressStatus(state, lessonId, collection, recordId) { return state.progress[lessonId]?.[collection]?.[recordId]?.status || 'new'; }
export function setProgress(state, lessonId, collection, recordId, status) {
  if (!LEVELS.includes(status) || !['sentences','words'].includes(collection)) fail('复习状态无效。');
  const lesson = state.lessons.find(item => item.id === lessonId);
  const record = (collection === 'sentences' ? lesson?.sentences : lesson?.vocabulary)?.find(item => item.id === recordId);
  if (!record) fail('这个练习内容不存在。');
  state.progress[lessonId] ||= { sentences: {}, words: {} };
  state.progress[lessonId][collection][recordId] = { status, signature: collection === 'sentences' ? record.text : wordSignature(record), updatedAt: new Date().toISOString() };
}

export class RoomRepository {
  constructor(storage, seed) {
    this.storage = storage;
    this.lastRaw = null;
    this.recoveryRaw = '';
    this.warning = '';
    this.suspended = false;
    const fallback = () => validateState({ version: 1, lessons: seed });
    try {
      this.lastRaw = storage?.getItem(ROOM_KEY) || null;
      if (this.lastRaw) {
        try { this.state = validateState(JSON.parse(this.lastRaw)); }
        catch { this.recoveryRaw = this.lastRaw; this.suspended = true; this.warning = '本地存档暂时无法读取，原始数据已保留。当前为临时模式，请先下载原始存档备份。'; this.state = fallback(); }
      } else { this.state = fallback(); this.update(() => {}); }
    } catch { this.state = fallback(); this.warning = '浏览器无法保存学习记录。当前可继续练习，请用「导出备份」保存课文和进度。'; }
  }
  update(mutator) {
    const next = structuredClone(this.state);
    mutator(next);
    const checked = validateState(next);
    if (!this.suspended) {
      try {
        if (!this.storage) throw new Error('storage unavailable');
        if ((this.storage.getItem(ROOM_KEY) || null) !== this.lastRaw) throw new RoomError('另一个标签页已更新课文库。请先复制当前编辑内容，再刷新本页载入最新数据。', 'conflict');
        const serialized = JSON.stringify(checked);
        this.storage.setItem(ROOM_KEY, serialized);
        this.lastRaw = serialized;
        this.warning = '';
      } catch (error) {
        if (error instanceof RoomError) throw error;
        this.warning = '这次更改暂未保存到浏览器，请保持页面打开，并导出备份。';
      }
    }
    this.state = checked;
    return checked;
  }
  export() { return JSON.stringify({ format: 'fusj-russian-room', ...this.state }, null, 2); }
  import(raw) { return this.update(next => Object.assign(next, mergeBackup(next, raw))); }
}

export function compareRecitation(expected, actual) {
  const tokenize = value => (speechText(value).toLocaleLowerCase('ru').match(/[\p{L}\p{N}]+/gu) || []);
  const wanted = tokenize(expected).slice(0, 350), received = tokenize(actual).slice(0, 350);
  const rows = Array.from({ length: wanted.length + 1 }, () => new Uint16Array(received.length + 1));
  for (let i = wanted.length - 1; i >= 0; i--) for (let j = received.length - 1; j >= 0; j--) rows[i][j] = wanted[i] === received[j] ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const missing = [], extra = [];
  let i = 0, j = 0;
  while (i < wanted.length || j < received.length) {
    if (i < wanted.length && j < received.length && wanted[i] === received[j]) { i++; j++; }
    else if (i < wanted.length && (j === received.length || rows[i + 1][j] >= rows[i][j + 1])) missing.push(wanted[i++]);
    else extra.push(received[j++]);
  }
  return { matched: rows[0][0], total: wanted.length, missing, extra, exact: !missing.length && !extra.length, truncated: tokenize(expected).length > 350 || tokenize(actual).length > 350 };
}
