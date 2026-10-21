import { ROOM_KEY, RoomRepository, newId, parsePassage, normalizeRussian, speechText, validateLesson, setProgress, progressStatus, compareRecitation } from './russian-core.js?v=1';
import { STARTER_LESSONS } from './russian-lessons.js?v=1';

const $ = id => document.getElementById(id);
const el = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const message = (id, text = '') => { $(id).textContent = text; $(id).hidden = !text; };
let storage = null;
try { storage = localStorage; } catch {}
const repo = new RoomRepository(storage, STARTER_LESSONS);
let mode = 'learn', hint = 2, role = 'all', sentenceId = null, showTranslation = true;
let wordView = 'list', wordKey = null, wordRevealed = false, wordOrder = [];
let lessonDraft = null, wordDraft = null, lessonDirty = false, wordDirty = false, rawDirty = false;
let voices = [], utterance = null, speechEpoch = 0;
const statusNames = { new: '还没自查', review: '待复习', mastered: '已掌握' };
const lesson = () => repo.state.lessons.find(item => item.id === repo.state.selectedLessonId);
const sentenceQueue = () => lesson().sentences.filter(item => (role === 'all' || item.speaker === role) && (!$('review-only').checked || progressStatus(repo.state, lesson().id, 'sentences', item.id) === 'review'));
const currentSentence = () => { const queue = sentenceQueue(); return queue.find(item => item.id === sentenceId) || queue[0]; };
const notice = text => message('room-notice', text);
function save(mutator) { repo.update(mutator); renderStorage(); }
function guarded(action) { try { return action(); } catch (error) { notice(error.message || '暂时无法完成操作，请重试。'); } }
function renderStorage() {
  $('storage-warning').hidden = !repo.warning;
  $('storage-message').textContent = repo.warning;
  $('recover-storage').hidden = !repo.recoveryRaw;
  $('storage-caption').textContent = repo.warning ? '当前更改可能只保留在页面内，请导出备份。' : '课文与进度保存在当前浏览器；导出备份可带到其他设备。';
}
function renderShelf() {
  $('library-count').textContent = repo.state.lessons.length;
  $('lesson-list').replaceChildren();
  for (const item of repo.state.lessons) {
    const count = item.sentences.filter(s => progressStatus(repo.state, item.id, 'sentences', s.id) === 'mastered').length;
    const button = el('button', `lesson-choice${item.id === lesson().id ? ' is-active' : ''}`);
    button.type = 'button'; button.setAttribute('aria-pressed', String(item.id === lesson().id));
    button.append(el('strong', '', item.title), el('small', '', `${item.sentences.length} 句 · 已掌握 ${count} 句`));
    button.addEventListener('click', () => guarded(() => {
      stopSpeech(); save(state => { state.selectedLessonId = item.id; }); role = 'all'; sentenceId = repo.state.cursors[item.id] || null; wordKey = null; wordOrder = []; wordRevealed = false; renderAll(true);
    }));
    $('lesson-list').append(button);
  }
}
function renderHeading() {
  const item = lesson();
  $('lesson-title').textContent = item.title;
  $('lesson-subtitle').textContent = normalizeRussian(item.subtitle);
  $('sentence-total').textContent = item.sentences.length;
  const count = item.sentences.filter(s => progressStatus(repo.state, item.id, 'sentences', s.id) === 'mastered').length;
  $('sentence-mastered').textContent = count;
  $('word-total').textContent = item.vocabulary.length;
  $('mastery-progress').max = item.sentences.length; $('mastery-progress').value = count;
  const roles = [...new Set(item.sentences.map(s => s.speaker).filter(Boolean))];
  if (!roles.includes(role)) role = 'all';
  $('role-filter').replaceChildren(new Option('全部角色', 'all'), ...roles.map(name => new Option(name, name)));
  $('role-filter').value = role;
}
function renderPractice(reset = false) {
  const queue = sentenceQueue(), current = currentSentence();
  if (reset) { hint = mode === 'learn' ? 2 : 0; $('recitation-input').value = ''; message('recitation-result'); stopSpeech(); }
  $('mode-learn').setAttribute('aria-pressed', String(mode === 'learn'));
  $('mode-recite').setAttribute('aria-pressed', String(mode === 'recite'));
  for (const id of ['sentence-paper','sentence-navigation','sentence-map']) $(id).hidden = !current;
  $('sentence-empty').hidden = !!current;
  $('word-from-sentence').disabled = !current;
  if (!current) { $('sentence-map').replaceChildren(); return; }
  sentenceId = current.id;
  const index = queue.findIndex(s => s.id === current.id), originalVisible = mode === 'learn' || hint >= 2;
  $('sentence-number').textContent = `${String(index + 1).padStart(2,'0')} / ${String(queue.length).padStart(2,'0')}`;
  $('sentence-status').textContent = statusNames[progressStatus(repo.state, lesson().id, 'sentences', current.id)];
  $('sentence-speaker').textContent = current.speaker || '课文';
  $('sentence-text').hidden = !originalVisible;
  $('sentence-text').textContent = originalVisible ? current.text : '';
  $('hidden-original').hidden = originalVisible;
  $('sentence-translation').textContent = showTranslation ? (current.translation || '这句尚未添加中文释义，可在「编辑课文」补充。') : '释义已隐藏，试着直接用俄语思考。';
  $('toggle-translation').textContent = showTranslation ? '隐藏释义' : '显示释义';
  $('keyword-hint').hidden = mode === 'recite' && hint < 1;
  $('sentence-keywords').replaceChildren(...(current.keywords.length ? current.keywords : ['这句尚未设置关键词']).map(text => { const keyword = el('span', '', text); if (current.keywords.length) keyword.lang = 'ru'; return keyword; }));
  $('next-hint').hidden = mode === 'learn'; $('next-hint').disabled = hint >= 2;
  $('next-hint').textContent = ['给我关键词','揭示原文','原文已揭示'][hint];
  $('show-answer').hidden = originalVisible;
  $('self-check').hidden = mode !== 'recite';
  for (const id of ['sentence-review','sentence-known','compare-recitation']) $(id).disabled = !originalVisible;
  $('self-rating-note').textContent = originalVisible ? '对照之后，再判断自己是否记住了。' : '揭示原文后，给自己一个诚实的判断。';
  $('previous-sentence').disabled = index === 0; $('next-sentence').disabled = index === queue.length - 1;
  $('sentence-position').textContent = `第 ${index + 1} 句，共 ${queue.length} 句`;
  $('sentence-map').replaceChildren(...queue.map((sentence, n) => {
    const button = el('button', '', String(n + 1).padStart(2,'0')); button.type = 'button';
    button.dataset.status = progressStatus(repo.state, lesson().id, 'sentences', sentence.id);
    button.setAttribute('aria-label', `第 ${n + 1} 句，${statusNames[button.dataset.status]}`);
    if (sentence.id === current.id) button.setAttribute('aria-current', 'step');
    button.addEventListener('click', () => moveTo(sentence.id)); return button;
  }));
  updateSpeechButtons();
}
function renderAll(reset = false) { renderShelf(); renderHeading(); renderPractice(reset); renderVocabulary(); renderStorage(); }
function moveTo(id) { guarded(() => { save(state => { state.cursors[lesson().id] = id; }); sentenceId = id; renderPractice(true); }); }
function moveSentence(delta) { const queue = sentenceQueue(), index = queue.findIndex(s => s.id === currentSentence()?.id); if (queue[index + delta]) moveTo(queue[index + delta].id); }
function setMode(value) { mode = value; renderPractice(true); }
function rateSentence(status) {
  guarded(() => {
    const current = currentSentence(); if (!current || mode !== 'recite' || hint < 2) return;
    save(state => setProgress(state, lesson().id, 'sentences', current.id, status));
    renderShelf(); renderHeading(); renderPractice(!sentenceQueue().some(item => item.id === current.id));
    $('self-rating-note').textContent = status === 'mastered' ? '已记下这次进步。可以继续下一句。' : '已加入待复习，之后可单独练习。';
  });
}

function stopSpeech() {
  speechEpoch++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  utterance = null;
  $('voice-status').textContent = voices.length ? '俄语朗读已就绪 · 重音以课堂标注为准。' : '当前设备未提供俄语语音，朗读暂不可用；仍可看重音和转写练习。';
}
function updateSpeechButtons() {
  const available = voices.length > 0;
  $('listen-sentence').disabled = !available || !currentSentence();
  $('listen-word').disabled = !available || !activeWord();
  document.querySelectorAll('[data-speech]').forEach(button => { button.disabled = !available; });
}
function loadVoices() {
  voices = 'speechSynthesis' in window ? speechSynthesis.getVoices().filter(voice => /^ru(?:[-_]|$)/i.test(voice.lang)).sort((a,b) => Number(b.localService) - Number(a.localService)) : [];
  $('voice-status').textContent = voices.length ? '俄语朗读已就绪 · 重音以课堂标注为准。' : '当前设备未提供俄语语音，朗读暂不可用；仍可看重音和转写练习。';
  updateSpeechButtons();
}
function speak(text) {
  if (!voices.length) { loadVoices(); if (!voices.length) return; }
  stopSpeech(); const epoch = speechEpoch;
  utterance = new SpeechSynthesisUtterance(speechText(text)); utterance.lang = voices[0].lang; utterance.voice = voices[0]; utterance.rate = Number($('speech-rate').value);
  $('voice-status').textContent = '正在朗读……';
  utterance.onend = () => { if (epoch === speechEpoch) loadVoices(); };
  utterance.onerror = event => { if (epoch === speechEpoch && !['canceled','interrupted'].includes(event.error)) $('voice-status').textContent = '这次朗读未能完成，请重试或检查设备的俄语语音。'; };
  speechSynthesis.speak(utterance);
}

function filteredWords() {
  const scope = $('word-scope').value, filter = $('word-filter').value, query = speechText($('word-search').value).toLocaleLowerCase('ru').trim();
  return (scope === 'all' ? repo.state.lessons : [lesson()]).flatMap(item => item.vocabulary.map(word => ({ lesson: item, word, key: `${item.id}/${word.id}`, status: progressStatus(repo.state, item.id, 'words', word.id) }))).filter(item => (filter === 'all' || item.status === filter) && (!query || speechText(`${item.word.word} ${item.word.meaning} ${item.word.example}`).toLocaleLowerCase('ru').includes(query)));
}
function orderedWords() {
  const words = filteredWords(), byKey = new Map(words.map(item => [item.key, item]));
  if (!wordOrder.length) return words.sort((a,b) => ({review:0,new:1,mastered:2}[a.status] - {review:0,new:1,mastered:2}[b.status]));
  return [...wordOrder.filter(key => byKey.has(key)).map(key => byKey.get(key)), ...words.filter(item => !wordOrder.includes(item.key))];
}
function activeWord() { const words = orderedWords(); return words.find(item => item.key === wordKey) || words[0]; }
function renderVocabulary() {
  const words = filteredWords();
  $('word-count').textContent = `${words.length} 个词与表达`;
  $('word-list-mode').setAttribute('aria-pressed', String(wordView === 'list'));
  $('word-card-mode').setAttribute('aria-pressed', String(wordView === 'cards'));
  $('vocabulary-empty').hidden = !!words.length;
  $('vocabulary-list').hidden = wordView !== 'list' || !words.length;
  $('word-practice').hidden = wordView !== 'cards' || !words.length;
  $('vocabulary-list').replaceChildren();
  if (wordView === 'list') for (const item of words) {
    const card = el('article','vocabulary-entry'), top = el('div','word-entry-top'), left = el('div'), actions = el('div');
    const title = el('h4','',item.word.pronunciation || item.word.word); title.lang = 'ru';
    left.append(title);
    const listen = el('button','room-link','朗读 ▷'); listen.type = 'button'; listen.dataset.speech = 'word'; listen.addEventListener('click', () => speak(item.word.pronunciation || item.word.word));
    const edit = el('button','room-link','编辑'); edit.type = 'button'; edit.setAttribute('aria-label', `编辑词汇 ${item.word.word}`); edit.addEventListener('click', () => openWord(item)); actions.append(listen,edit); top.append(left,actions);
    card.append(top,el('p','word-meaning',item.word.meaning));
    if (item.word.example || item.word.exampleTranslation) { const example = el('div','word-example'); const ru = el('p','',item.word.example); ru.lang = 'ru'; example.append(ru,el('p','',item.word.exampleTranslation)); card.append(example); }
    const footer = el('div','word-entry-footer'); footer.append(el('span','',item.lesson.title),el('span','',statusNames[item.status])); card.append(footer); $('vocabulary-list').append(card);
  }
  const current = activeWord();
  if (current) {
    wordKey = current.key;
    const direction = $('word-direction').value, queue = orderedWords();
    $('flash-position').textContent = `${queue.findIndex(item => item.key === current.key) + 1} / ${queue.length}`;
    $('flash-prompt').textContent = direction === 'ru-zh' ? '先想一想中文意思' : '试着说出对应的俄语';
    $('flash-front').textContent = direction === 'ru-zh' ? (current.word.pronunciation || current.word.word) : current.word.meaning;
    $('flash-front').lang = direction === 'ru-zh' ? 'ru' : 'zh-CN';
    $('flash-back').hidden = !wordRevealed; $('flash-back').textContent = wordRevealed ? (direction === 'ru-zh' ? current.word.meaning : current.word.pronunciation || current.word.word) : '';
    $('flash-back').lang = direction === 'ru-zh' ? 'zh-CN' : 'ru';
    $('flash-instruction').textContent = wordRevealed ? '想好之后，给这张卡一个判断。' : '点击翻卡，核对答案 ↗';
    $('flash-example').hidden = !wordRevealed || (!current.word.example && !current.word.exampleTranslation);
    $('flash-example-ru').textContent = wordRevealed ? current.word.example : ''; $('flash-example-zh').textContent = wordRevealed ? current.word.exampleTranslation : '';
  }
  for (const id of ['word-review','word-known']) $(id).disabled = !current || !wordRevealed;
  updateSpeechButtons();
}
function nextWord() { const queue = orderedWords(), index = queue.findIndex(item => item.key === activeWord()?.key); wordKey = queue[(index + 1) % queue.length]?.key || null; wordRevealed = false; stopSpeech(); renderVocabulary(); }
function rateWord(status) {
  guarded(() => {
    const current = activeWord(); if (!current || !wordRevealed) return;
    const queue = orderedWords(), index = queue.findIndex(item => item.key === current.key), next = queue[(index + 1) % queue.length]?.key;
    save(state => setProgress(state, current.lesson.id, 'words', current.word.id, status));
    wordKey = next; wordRevealed = false; renderVocabulary();
  });
}
function setTab(value, focus = false) {
  for (const tab of ['reading','vocabulary']) { const active = tab === value; $(`tab-${tab}`).setAttribute('aria-selected', String(active)); $(`tab-${tab}`).tabIndex = active ? 0 : -1; $(`${tab}-panel`).hidden = !active; }
  stopSpeech(); if (focus) $(`tab-${value}`).focus();
}

function fieldNode(label, name, value, multiline = false) {
  const wrapper = el('label','',label), input = el(multiline ? 'textarea' : 'input'); input.dataset.field = name; input.value = value || '';
  input.maxLength = name === 'speaker' ? 50 : name === 'keywords' ? 2100 : 2000;
  if (multiline) input.rows = 2;
  if (['text','pronunciation','speaker','keywords'].includes(name)) input.lang = 'ru';
  wrapper.append(input); return wrapper;
}
function collectSentences() {
  return Array.from($('sentence-editors').children, card => {
    const value = key => card.querySelector(`[data-field="${key}"]`).value;
    return { id: card.dataset.id, text: value('text'), speaker: value('speaker'), translation: value('translation'), pronunciation: lessonDraft.sentences.find(sentence => sentence.id === card.dataset.id)?.pronunciation || '', keywords: value('keywords').split(/[,，;；]/).map(s => s.trim()).filter(Boolean) };
  });
}
function renderSentenceEditors() {
  $('sentence-editors').replaceChildren(...lessonDraft.sentences.map((sentence,index) => {
    const card = el('div','sentence-edit-card'); card.dataset.id = sentence.id;
    const top = el('div','sentence-edit-top'), remove = el('button','room-link','移除这一句'); remove.type = 'button'; remove.setAttribute('aria-label', `移除第 ${index + 1} 句`);
    remove.addEventListener('click', () => { lessonDraft.sentences = collectSentences().filter(s => s.id !== sentence.id); lessonDirty = true; renderSentenceEditors(); });
    top.append(el('span','',`第 ${index + 1} 句`),remove);
    const row = el('div','form-pair'); row.append(fieldNode('角色（选填）','speaker',sentence.speaker),fieldNode('关键词，用逗号分隔','keywords',sentence.keywords.join('，')));
    card.append(top,fieldNode('俄语原文','text',sentence.text,true),fieldNode('中文释义','translation',sentence.translation,true),row);
    return card;
  }));
}
function openLesson(existing = null) {
  lessonDraft = existing ? structuredClone(existing) : { id: newId(), title: '', subtitle: '', sentences: [], vocabulary: [] };
  $('lesson-editor-title').textContent = existing ? '编辑课文与提示' : '导入新课文';
  $('edit-lesson-title').value = lessonDraft.title; $('edit-lesson-subtitle').value = lessonDraft.subtitle;
  $('passage-input').value = existing ? existing.sentences.map(s => `${s.speaker ? `${s.speaker}: ` : ''}${s.text}${s.translation ? `（${s.translation}）` : ''}`).join('\n') : '';
  $('source-details').open = !existing; $('delete-lesson').hidden = !existing;
  $('parse-message').textContent = existing ? '原文改变时，该句的背诵进度会重新计起；其他句子的进度保留。' : '粘贴后点击「整理为逐句练习」，也可直接保存。';
  message('lesson-error'); lessonDirty = false; rawDirty = false; renderSentenceEditors(); $('lesson-dialog').showModal(); $('edit-lesson-title').focus();
}
function splitPassage() {
  const result = parsePassage($('passage-input').value, collectSentences());
  lessonDraft.sentences = result.sentences;
  if (!$('edit-lesson-title').value.trim() && result.title) $('edit-lesson-title').value = result.title;
  renderSentenceEditors(); rawDirty = false; lessonDirty = true;
  $('parse-message').textContent = `已整理 ${result.sentences.length} 句。${result.warnings.length ? '\n' + result.warnings.join('\n') : '请核对分句、中文释义和重音，再保存。'}`;
}
function openWord(existing = null, fromSentence = null) {
  const selected = window.getSelection()?.toString().trim() || '';
  const selectionInSentence = $('sentence-text').contains(window.getSelection()?.anchorNode);
  const picked = fromSentence && selectionInSentence && /[\u0400-\u04ff]/.test(selected) && selected.length <= 120 ? selected : '';
  wordDraft = { lessonId: existing?.lesson.id || lesson().id, id: existing?.word.id || newId(), existing: !!existing };
  $('word-editor-title').textContent = existing ? '编辑词条' : '记一个新词';
  $('edit-word-lesson').replaceChildren(...repo.state.lessons.map(item => new Option(item.title,item.id))); $('edit-word-lesson').value = wordDraft.lessonId; $('edit-word-lesson').disabled = !!existing;
  $('edit-word').value = existing?.word.word || speechText(picked);
  $('edit-word-reading').value = existing?.word.pronunciation || picked;
  $('edit-word-meaning').value = existing?.word.meaning || '';
  $('edit-word-example').value = existing?.word.example || fromSentence?.text || '';
  $('edit-word-translation').value = existing?.word.exampleTranslation || fromSentence?.translation || '';
  $('delete-word').hidden = !existing; message('word-error'); wordDirty = false; $('word-dialog').showModal(); $('edit-word').focus();
}
function closeDialog(id) {
  const dirty = id === 'lesson-dialog' ? lessonDirty : wordDirty;
  if (dirty && !confirm('编辑内容还没有保存，关闭后会丢失。确定关闭吗？')) return;
  $(id).close(); if (id === 'lesson-dialog') lessonDirty = false; else wordDirty = false;
}
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = el('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('new-lesson').addEventListener('click', () => openLesson());
$('edit-lesson').addEventListener('click', () => openLesson(lesson()));
$('lesson-form').addEventListener('input', () => { lessonDirty = true; });
$('passage-input').addEventListener('input', () => { rawDirty = true; });
$('split-passage').addEventListener('click', () => { try { splitPassage(); message('lesson-error'); } catch (error) { message('lesson-error',error.message); } });
$('append-sentence').addEventListener('click', () => { lessonDraft.sentences = collectSentences(); lessonDraft.sentences.push({ id: newId(), text: '', speaker: '', translation: '', pronunciation: '', keywords: [] }); lessonDirty = true; renderSentenceEditors(); });
$('lesson-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if (rawDirty || (!collectSentences().length && $('passage-input').value.trim())) splitPassage();
    const item = validateLesson({ ...lessonDraft, title: $('edit-lesson-title').value, subtitle: $('edit-lesson-subtitle').value, sentences: collectSentences() });
    save(state => { const index = state.lessons.findIndex(l => l.id === item.id); if (index === -1) state.lessons.push(item); else state.lessons[index] = item; state.selectedLessonId = item.id; });
    lessonDirty = false; $('lesson-dialog').close(); role = 'all'; sentenceId = repo.state.cursors[item.id] || null; wordKey = null; wordOrder = []; $('review-only').checked = false; renderAll(true); notice('课文已整理好，可以开始练习。');
  } catch (error) { message('lesson-error',error.message); }
});
$('delete-lesson').addEventListener('click', () => {
  if (repo.state.lessons.length === 1) { message('lesson-error','请先添加另一篇课文，再删除这一篇。'); return; }
  if (!confirm(`删除「${lessonDraft.title}」及其当前设备上的进度？建议先导出备份。`)) return;
  try { save(state => { state.lessons = state.lessons.filter(item => item.id !== lessonDraft.id); if (state.selectedLessonId === lessonDraft.id) state.selectedLessonId = state.lessons[0].id; }); lessonDirty = false; $('lesson-dialog').close(); role = 'all'; sentenceId = null; wordKey = null; renderAll(true); notice('这篇课文已从当前设备移除。'); }
  catch (error) { message('lesson-error',error.message); }
});
$('add-word').addEventListener('click', () => openWord());
$('word-from-sentence').addEventListener('click', () => { if (currentSentence()) openWord(null,currentSentence()); });
$('word-form').addEventListener('input', () => { wordDirty = true; });
$('word-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const targetId = $('edit-word-lesson').value;
    const word = { id: wordDraft.id, word: $('edit-word').value, pronunciation: $('edit-word-reading').value, meaning: $('edit-word-meaning').value, example: $('edit-word-example').value, exampleTranslation: $('edit-word-translation').value };
    save(state => { const item = state.lessons.find(l => l.id === targetId); const index = item.vocabulary.findIndex(w => w.id === word.id); if (index === -1) item.vocabulary.push(word); else item.vocabulary[index] = word; });
    wordDirty = false; $('word-dialog').close(); if (targetId !== lesson().id) $('word-scope').value = 'all'; wordKey = `${targetId}/${word.id}`; wordRevealed = false; renderHeading(); renderVocabulary(); notice('词条已保存到词汇专栏。');
  } catch (error) { message('word-error',error.message); }
});
$('delete-word').addEventListener('click', () => {
  if (!confirm('删除这个词条及其当前设备上的复习记录？')) return;
  try { save(state => { const item = state.lessons.find(l => l.id === wordDraft.lessonId); item.vocabulary = item.vocabulary.filter(w => w.id !== wordDraft.id); }); wordDirty = false; $('word-dialog').close(); wordKey = null; wordRevealed = false; renderHeading(); renderVocabulary(); }
  catch (error) { message('word-error',error.message); }
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => closeDialog(button.dataset.close));
for (const id of ['lesson-dialog','word-dialog']) $(id).addEventListener('cancel', event => { event.preventDefault(); closeDialog(id); });
$('export-backup').addEventListener('click', () => download(repo.export(),'russian-room-backup.json'));
$('recover-storage').addEventListener('click', () => download(repo.recoveryRaw,'russian-room-original-recovery.json'));
$('import-backup').addEventListener('click', () => $('backup-file').click());
$('backup-file').addEventListener('change', async () => {
  const file = $('backup-file').files[0]; if (!file) return;
  try { if (file.size > 4000000) throw new Error('备份文件过大，请使用 4 MB 以内的 JSON 备份。'); const raw = JSON.parse(await file.text()); repo.import(raw); role = 'all'; sentenceId = null; wordKey = null; wordOrder = []; $('review-only').checked = false; renderAll(true); notice('备份已作为新课文加入，已有课文不会被覆盖。'); }
  catch (error) { notice(error instanceof SyntaxError ? '无法读取这个 JSON 文件，请选择练习室导出的备份。' : error.message); }
  finally { $('backup-file').value = ''; }
});
$('mode-learn').addEventListener('click', () => setMode('learn')); $('mode-recite').addEventListener('click', () => setMode('recite'));
$('role-filter').addEventListener('change', () => { role = $('role-filter').value; renderPractice(true); });
$('review-only').addEventListener('change', () => renderPractice(true));
$('show-all-sentences').addEventListener('click', () => { $('review-only').checked = false; role = 'all'; $('role-filter').value = 'all'; renderPractice(true); });
$('toggle-translation').addEventListener('click', () => { showTranslation = !showTranslation; renderPractice(); });
$('next-hint').addEventListener('click', () => { hint = Math.min(2,hint + 1); renderPractice(); });
$('show-answer').addEventListener('click', () => { hint = 2; renderPractice(); });
$('previous-sentence').addEventListener('click', () => moveSentence(-1)); $('next-sentence').addEventListener('click', () => moveSentence(1));
$('sentence-review').addEventListener('click', () => rateSentence('review')); $('sentence-known').addEventListener('click', () => rateSentence('mastered'));
$('listen-sentence').addEventListener('click', () => { if (currentSentence()) speak(currentSentence().text); });
$('compare-recitation').addEventListener('click', () => {
  if (hint < 2 || !currentSentence()) return;
  const attempt = $('recitation-input').value.trim(); if (!attempt) { message('recitation-result','先在上方写一句俄语，再对照。'); return; }
  const result = compareRecitation(currentSentence().text,attempt);
  message('recitation-result', result.exact ? '文字对照一致。再听一次，检查自己的发音和重音。' : `匹配 ${result.matched} / ${result.total} 个词。\n${result.missing.length ? `漏写或需改正：${result.missing.join(' · ')}\n` : ''}${result.extra.length ? `多写或不同的词：${result.extra.join(' · ')}` : ''}${result.truncated ? '\n仅对照了前 350 个词。' : ''}`);
});
for (const tab of ['reading','vocabulary']) {
  $(`tab-${tab}`).addEventListener('click', () => setTab(tab));
  $(`tab-${tab}`).addEventListener('keydown', event => { if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); setTab(tab === 'reading' ? 'vocabulary' : 'reading',true); } });
}
for (const id of ['word-search','word-scope','word-filter','word-direction']) $(id).addEventListener(id === 'word-search' ? 'input' : 'change', () => { wordKey = null; wordOrder = []; wordRevealed = false; renderVocabulary(); });
$('word-list-mode').addEventListener('click', () => { wordView = 'list'; renderVocabulary(); });
$('word-card-mode').addEventListener('click', () => { wordView = 'cards'; wordRevealed = false; renderVocabulary(); });
$('flip-word').addEventListener('click', () => { wordRevealed = !wordRevealed; renderVocabulary(); });
$('next-word').addEventListener('click', nextWord);
$('word-review').addEventListener('click', () => rateWord('review')); $('word-known').addEventListener('click', () => rateWord('mastered'));
$('listen-word').addEventListener('click', () => { const current = activeWord(); if (current) speak(current.word.pronunciation || current.word.word); });
$('shuffle-words').addEventListener('click', () => { const keys = filteredWords().map(item => item.key); for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [keys[i],keys[j]] = [keys[j],keys[i]]; } wordOrder = keys; wordKey = keys[0]; wordRevealed = false; renderVocabulary(); });
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable="true"]') || $('reading-panel').hidden) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveSentence(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveSentence(1); }
  if (event.key.toLowerCase() === 'h' && mode === 'recite') { event.preventDefault(); hint = Math.min(2,hint + 1); renderPractice(); }
});
window.addEventListener('storage', event => { if (event.key === ROOM_KEY) notice('另一个标签页已更新课文库。请先保存或复制编辑内容，再刷新本页载入最新记录。'); });
window.addEventListener('beforeunload', event => { if (lessonDirty || wordDirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', stopSpeech);
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged',loadVoices);
sentenceId = repo.state.cursors[lesson().id] || null;
renderAll(true); loadVoices();
