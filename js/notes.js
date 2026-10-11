import { GitHubNotesStore, NOTE_CATEGORIES, validateDocument } from './notes-store.js';

const store = new GitHubNotesStore();
const $ = id => document.getElementById(id);
const DRAFT_KEY = 'fusj.notes.draft.v1';
let notes = [];
let category = 'all';
let readerId = null;
let editor = null;
let busy = false;
let requestSequence = 0;
let draftTimer;
let loaded = false;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });

function text(element, value) { element.textContent = value; }
function showMessage(id, message) { text($(id), message); $(id).hidden = !message; }
function date(value) { return dateFormat.format(new Date(value)); }
function createElement(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  if (value !== undefined) text(element, value);
  return element;
}

function readDraft() {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 100
      || typeof value.title !== 'string' || value.title.length > 120
      || typeof value.content !== 'string' || value.content.length > 50000
      || !Object.hasOwn(NOTE_CATEGORIES, value.category)) return null;
    if (value.original) validateDocument({ version: 1, notes: [value.original] });
    if (value.original && value.original.id !== value.id) return null;
    if (value.pendingNote) {
      validateDocument({ version: 1, notes: [value.pendingNote] });
      if (value.pendingNote.id !== value.id || value.pendingNote.title !== value.title.trim()
        || value.pendingNote.content !== value.content.trim() || value.pendingNote.category !== value.category
        || (value.original && value.pendingNote.createdAt !== value.original.createdAt)) value.pendingNote = null;
    }
    return value;
  } catch { return null; }
}

function updateDraftBanner() { $('draft-banner').hidden = !store.connected || !readDraft(); }
function clearDraft(id) {
  try { if (readDraft()?.id === id) localStorage.removeItem(DRAFT_KEY); } catch {}
  updateDraftBanner();
}

function saveDraft() {
  clearTimeout(draftTimer);
  if (!editor || !$('editor-dialog').open) return;
  const draft = { id: editor.id, original: editor.original, title: $('note-title').value, category: $('note-category').value, content: $('note-content').value, pendingNote: editor.pendingNote || null };
  if (!draft.title && !draft.content && !editor.original) return true;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    text($('draft-status'), '草稿已保存在当前设备');
  } catch {
    text($('draft-status'), '此浏览器无法保存草稿，请保持页面打开或复制正文');
    return false;
  }
  updateDraftBanner();
  return true;
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('.notes-dialog button, .notes-dialog input, .notes-dialog select, .notes-dialog textarea, .notes-heading button, #empty-create, #resume-draft, #refresh-notes').forEach(element => { element.disabled = value; });
  $('publish-note').textContent = value ? '正在处理…' : (editor?.original ? '发布修改 ↗' : '发布笔记 ↗');
}

function render() {
  const query = $('note-search').value.trim().toLocaleLowerCase();
  const visible = notes.filter(note => (category === 'all' || note.category === category) && (!query || `${note.title}\n${note.content}`.toLocaleLowerCase().includes(query))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  $('notes-list').replaceChildren();
  for (const note of visible) {
    const card = createElement('button', 'note-card');
    card.type = 'button';
    card.setAttribute('aria-label', `阅读笔记：${note.title}`);
    const topline = createElement('span', 'note-card-topline');
    topline.append(createElement('span', '', NOTE_CATEGORIES[note.category]), createElement('span', '', `${Array.from(note.content).length} 字`));
    const footer = createElement('span', 'note-card-footer');
    footer.append(createElement('span', '', date(note.updatedAt)), createElement('span', '', '阅读全文 ↗'));
    card.append(topline, createElement('h3', '', note.title), createElement('p', '', note.content.replace(/\s+/g, ' ')), footer);
    card.addEventListener('click', () => openReader(note.id));
    $('notes-list').append(card);
  }
  text($('notes-count'), notes.length);
  $('notes-empty').hidden = visible.length > 0;
  $('notes-list').hidden = visible.length === 0;
  const filtered = query || category !== 'all';
  text($('empty-title'), !loaded ? '笔记暂时无法读取' : filtered ? '这里还没有匹配的笔记。' : '第一篇，留给一个值得记下的想法。');
  text($('empty-copy'), !loaded ? '请检查网络，再点击「刷新笔记」重试。' : filtered ? '试试其他关键词，或切回「全部」。' : '这里还没有公开笔记。新的文章、灵感和学习记录会陆续出现。');
  $('empty-create').hidden = !store.connected || !!filtered || !loaded;
  $('new-note').hidden = !store.connected;
  $('connect-notes').hidden = store.connected;
  $('disconnect-notes').hidden = !store.connected;
  $('reader-actions').hidden = !store.connected;
  updateDraftBanner();
}

function acceptSnapshot(snapshot) {
  notes = snapshot.document.notes;
  loaded = true;
  render();
}

async function loadNotes() {
  const sequence = ++requestSequence;
  text($('sync-status'), '正在读取公开笔记…');
  $('refresh-notes').disabled = true;
  // Public reading also works when the browser cannot reach GitHub's API.
  if (!store.connected) {
    try {
      const response = await fetch('data/notes.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('backup');
      const document = validateDocument(await response.json());
      if (sequence !== requestSequence) return;
      acceptSnapshot({ document });
      text($('sync-status'), '网站已发布版本');
      openLinkedNote(false);
    } catch { /* Online reading below remains available when the bundled file is absent. */ }
  }
  try {
    const snapshot = await store.read();
    if (sequence !== requestSequence) return;
    acceptSnapshot(snapshot);
    showMessage('notes-notice', '');
    text($('sync-status'), store.connected ? '作者管理 · 已与在线笔记同步' : '公开笔记 · 已同步');
    $('sync-status').title = '';
  } catch (error) {
    if (sequence !== requestSequence) return;
    if (!loaded) {
      try {
        const response = await fetch('data/notes.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('backup');
        const document = validateDocument(await response.json());
        if (sequence !== requestSequence) return;
        acceptSnapshot({ document });
      } catch { if (sequence === requestSequence) render(); }
    }
    if (sequence !== requestSequence) return;
    text($('sync-status'), loaded && !store.connected ? '网站已发布版本' : '在线同步暂不可用');
    $('sync-status').title = loaded && !store.connected ? '即时更新暂不可用，正在显示网站最近发布的内容。' : '';
    showMessage('notes-notice', loaded && !store.connected ? '' : loaded ? '暂时无法读取在线更新，已保留当前显示的笔记。发布前会重新核对在线版本。' : error.message);
  } finally {
    if (sequence === requestSequence) $('refresh-notes').disabled = busy;
  }
  openLinkedNote();
}

function openLinkedNote(reportMissing = true) {
  const linkedId = new URLSearchParams(location.hash.slice(1)).get('note');
  if (linkedId && !readerId) {
    if (notes.some(note => note.id === linkedId)) openReader(linkedId);
    else if (reportMissing) showMessage('notes-notice', '这篇笔记不存在或已删除。可以浏览下面的其他笔记。');
  }
}

function openReader(id) {
  const note = notes.find(item => item.id === id);
  if (!note) return;
  readerId = id;
  text($('reader-category'), NOTE_CATEGORIES[note.category]);
  text($('reader-title'), note.title);
  text($('reader-date'), `发布于 ${date(note.createdAt)}${note.updatedAt !== note.createdAt ? ` · 更新于 ${date(note.updatedAt)}` : ''}`);
  text($('reader-content'), note.content);
  $('reader-actions').hidden = !store.connected;
  history.replaceState(null, '', `#note=${encodeURIComponent(id)}`);
  if (!$('reader-dialog').open) $('reader-dialog').showModal();
}

function openEditor(original = null, draft = null) {
  if (!store.connected || busy) return;
  const otherDraft = readDraft();
  const targetId = draft?.id || original?.id;
  if (!draft && otherDraft && otherDraft.id !== targetId && !window.confirm('当前设备还有一篇未发布的草稿。开始另一篇会替换它，要继续吗？')) return;
  editor = { id: targetId || crypto.randomUUID(), original: draft?.original || original, pendingNote: draft?.pendingNote || null };
  $('note-title').value = draft?.title ?? original?.title ?? '';
  $('note-category').value = draft?.category ?? original?.category ?? 'note';
  $('note-content').value = draft?.content ?? original?.content ?? '';
  text($('editor-heading'), editor.original ? '编辑笔记' : '新建笔记');
  text($('publish-note'), editor.original ? '发布修改 ↗' : '发布笔记 ↗');
  text($('character-count'), `${Array.from($('note-content').value).length} 字`);
  text($('draft-status'), draft ? '已恢复当前设备的草稿' : '发布前的内容只作为本地草稿保存');
  $('delete-note').hidden = !editor.original;
  showMessage('editor-error', '');
  $('reader-dialog').close();
  $('editor-dialog').showModal();
  $('note-title').focus();
}

$('connect-notes').addEventListener('click', () => {
  showMessage('connect-error', '');
  $('connect-dialog').showModal();
});
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  if (!window.isSecureContext) {
    showMessage('connect-error', '请通过 HTTPS 网站或 localhost 本地预览连接管理账号。');
    return;
  }
  setBusy(true);
  showMessage('connect-error', '');
  const sequence = ++requestSequence;
  const token = $('github-token').value;
  $('github-token').value = '';
  text($('connect-submit'), '正在连接…');
  try {
    const snapshot = await store.connect(token);
    if (sequence !== requestSequence) return;
    acceptSnapshot(snapshot);
    text($('sync-status'), '作者管理 · 已与在线笔记同步');
    $('sync-status').title = '';
    showMessage('notes-notice', '');
    $('connect-dialog').close();
  } catch (error) { showMessage('connect-error', error.code === 'network' ? '当前浏览器暂时无法连接 GitHub。请用能访问 GitHub 的常规浏览器打开网站后重试，或检查网络连接。' : error.message); }
  finally { setBusy(false); text($('connect-submit'), '连接并管理 ↗'); }
});
$('connect-dialog').addEventListener('close', () => { $('github-token').value = ''; });
$('disconnect-notes').addEventListener('click', () => {
  if (busy) return;
  saveDraft();
  store.disconnect();
  render();
  text($('sync-status'), '已退出管理 · 公开笔记');
});

$('new-note').addEventListener('click', () => openEditor());
$('empty-create').addEventListener('click', () => openEditor());
$('resume-draft').addEventListener('click', () => { const draft = readDraft(); if (draft) openEditor(null, draft); });
$('edit-note').addEventListener('click', () => {
  const note = notes.find(item => item.id === readerId);
  const draft = readDraft();
  if (note) openEditor(note, draft?.id === note.id ? draft : null);
});
$('refresh-notes').addEventListener('click', () => { if (!busy) loadNotes(); });
$('note-search').addEventListener('input', render);
document.querySelectorAll('.note-filter').forEach(button => button.addEventListener('click', () => {
  category = button.dataset.category;
  document.querySelectorAll('.note-filter').forEach(filter => {
    filter.classList.toggle('is-active', filter === button);
    filter.setAttribute('aria-pressed', String(filter === button));
  });
  render();
}));

['note-title', 'note-category', 'note-content'].forEach(id => $(id).addEventListener('input', () => {
  if (!editor) return;
  editor.pendingNote = null;
  text($('character-count'), `${Array.from($('note-content').value).length} 字`);
  text($('draft-status'), '正在保存草稿…');
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 350);
}));

$('note-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !editor || !store.connected) return;
  showMessage('editor-error', '');
  const title = $('note-title').value.trim();
  const content = $('note-content').value.trim();
  if (!title || !content) { showMessage('editor-error', '标题和正文都需要有内容。'); return; }
  const selectedCategory = $('note-category').value;
  if (editor.original && ['title', 'content', 'category'].every(key => editor.original[key] === ({ title, content, category: selectedCategory })[key])) {
    clearDraft(editor.id);
    $('editor-dialog').close();
    editor = null;
    showMessage('notes-notice', '内容没有变化，已保留原来的公开笔记。');
    return;
  }
  const now = new Date().toISOString();
  const note = editor.pendingNote || { id: editor.id, title, content, category: selectedCategory, createdAt: editor.original?.createdAt || now, updatedAt: now };
  editor.pendingNote = note;
  saveDraft();
  setBusy(true);
  try {
    const snapshot = await store.save(note, editor.original);
    ++requestSequence;
    acceptSnapshot(snapshot);
    clearDraft(editor.id);
    $('editor-dialog').close();
    editor = null;
    text($('sync-status'), '已发布 · 所有设备可读取');
    showMessage('notes-notice', '笔记已公开发布。');
    openReader(note.id);
  } catch (error) { showMessage('editor-error', error.message); }
  finally { setBusy(false); }
});

$('delete-note').addEventListener('click', async () => {
  if (busy || !editor?.original || !window.confirm(`要从公开笔记中删除「${editor.original.title}」吗？`)) return;
  setBusy(true);
  showMessage('editor-error', '');
  try {
    const snapshot = await store.remove(editor.original);
    ++requestSequence;
    acceptSnapshot(snapshot);
    clearDraft(editor.id);
    $('editor-dialog').close();
    editor = null;
    text($('sync-status'), '已同步删除');
    showMessage('notes-notice', '笔记已从公开列表中删除。历史版本仍可在仓库中查看。');
  } catch (error) { showMessage('editor-error', error.message); }
  finally { setBusy(false); }
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
  if (busy) return;
  if (button.dataset.close === 'editor-dialog' && saveDraft() === false) {
    showMessage('editor-error', '此浏览器未能保存草稿，请先复制标题和正文后再离开。');
    if (!window.confirm('草稿未能保存。请确认已经复制需要的内容，仍要关闭编辑器吗？')) return;
  }
  $(button.dataset.close).close();
}));
document.querySelectorAll('.notes-dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
    else if (dialog.id === 'editor-dialog' && saveDraft() === false) {
      showMessage('editor-error', '此浏览器未能保存草稿，请先复制标题和正文后再离开。');
      if (!window.confirm('草稿未能保存。请确认已经复制需要的内容，仍要关闭编辑器吗？')) event.preventDefault();
    }
  });
});
$('reader-dialog').addEventListener('close', () => {
  readerId = null;
  if (location.hash.startsWith('#note=')) history.replaceState(null, '', location.pathname + location.search);
});
window.addEventListener('pagehide', saveDraft);
window.addEventListener('beforeunload', event => {
  const saved = saveDraft();
  if (busy || saved === false) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('hashchange', () => {
  const id = new URLSearchParams(location.hash.slice(1)).get('note');
  if (id) openReader(id); else $('reader-dialog').close();
});

loadNotes();
