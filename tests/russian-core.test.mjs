import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_KEY, RoomRepository, parsePassage, validateLesson, validateState, normalizeRussian, speechText, transliterate, setProgress, progressStatus, compareRecitation } from '../js/russian-core.js';
import { STARTER_LESSONS } from '../js/russian-lessons.js';
function memory() { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key,value) => values.set(key,value) }; }
const makeRepo = (storage = memory()) => new RoomRepository(storage, STARTER_LESSONS);

test('The supplied classroom dialogue has all 20 sentences, three roles and 16 vocabulary entries', () => {
  const lesson = makeRepo().state.lessons[0];
  assert.equal(lesson.sentences.length,20); assert.equal(lesson.vocabulary.length,16);
  assert.deepEqual([...new Set(lesson.sentences.map(s => s.speaker))],['Ли Пин','Антон','Анна']);
  assert.ok(lesson.sentences.every(s => s.translation && s.keywords.length));
  assert.ok(lesson.sentences.at(-1).text.includes('о́чень'));
});
test('Mixed Latin stress letters become Cyrillic stress marks; speech retains ё', () => {
  assert.equal(normalizeRussian('Здрáвствуйте! Я приéхал из Китáя.'),'Здра́вствуйте! Я прие́хал из Кита́я.');
  assert.equal(speechText('Меня́. Её.'),'Меня. Её.');
  assert.equal(transliterate('Китáй'),'Kitáy');
});
test('Pasted dialogue splits Russian and Chinese in alignment and detects the title', () => {
  const parsed = parsePassage('ДАВÁЙТЕ ПОЗНАКÓМИМСЯ (让我们认识一下)\nАнтóн: Хорошó. Меня́ зову́т Антóн. А как вас зову́т? (好的。我叫安东。您叫什么名字？)');
  assert.equal(parsed.title,'让我们认识一下'); assert.equal(parsed.sentences.length,3);
  assert.deepEqual(parsed.sentences.map(s => s.translation),['好的。','我叫安东。','您叫什么名字？']);
  assert.equal(parsed.sentences[0].speaker,'Анто́н'); assert.equal(parsed.warnings.length,0);
});
test('Re-splitting preserves annotations and stable IDs, including repeated identical lines', () => {
  const first = parsePassage('Да.\nДа.'); first.sentences[0].keywords = ['one']; first.sentences[1].translation = '是的。';
  const next = parsePassage('Да.\nДа.\nНет.',first.sentences);
  assert.equal(next.sentences[0].id,first.sentences[0].id); assert.equal(next.sentences[1].id,first.sentences[1].id);
  assert.deepEqual(next.sentences[0].keywords,['one']); assert.equal(next.sentences[1].translation,'是的。');
});
test('Unaligned bilingual text is flagged rather than silently inventing sentence translations', () => {
  const result = parsePassage('Я студент. Меня зовут Антон.（我是学生，我叫安东。）');
  assert.equal(result.warnings.length,1); assert.equal(result.sentences[1].translation,'');
  assert.throws(() => parsePassage('只有中文。')); assert.throws(() => parsePassage('а'.repeat(60001)));
});
test('Learning progress and selected position survive a fresh repository instance', () => {
  const storage = memory(), repo = makeRepo(storage), lesson = repo.state.lessons[0], sentence = lesson.sentences[4];
  repo.update(state => { setProgress(state,lesson.id,'sentences',sentence.id,'mastered'); state.cursors[lesson.id] = sentence.id; });
  const restored = makeRepo(storage);
  assert.equal(progressStatus(restored.state,lesson.id,'sentences',sentence.id),'mastered'); assert.equal(restored.state.cursors[lesson.id],sentence.id);
});
test('Changing the Russian sentence resets only its progress; editing a translation preserves progress', () => {
  const repo = makeRepo(), lesson = repo.state.lessons[0], [a,b] = lesson.sentences;
  repo.update(state => { setProgress(state,lesson.id,'sentences',a.id,'mastered'); setProgress(state,lesson.id,'sentences',b.id,'review'); });
  repo.update(state => { state.lessons[0].sentences[0].translation = '你好！'; });
  assert.equal(progressStatus(repo.state,lesson.id,'sentences',a.id),'mastered');
  repo.update(state => { state.lessons[0].sentences[0].text = 'Привет!'; });
  assert.equal(progressStatus(repo.state,lesson.id,'sentences',a.id),'new'); assert.equal(progressStatus(repo.state,lesson.id,'sentences',b.id),'review');
});
test('Backup import preserves progress and creates a copy when IDs collide without overwriting a lesson', () => {
  const repo = makeRepo(), first = repo.state.lessons[0], word = first.vocabulary[0];
  repo.update(state => setProgress(state,first.id,'words',word.id,'mastered'));
  const backup = JSON.parse(repo.export()); repo.import(backup);
  assert.equal(repo.state.lessons.length,2); assert.equal(repo.state.lessons[0].id,first.id);
  const imported = repo.state.lessons[1]; assert.notEqual(imported.id,first.id);
  assert.equal(progressStatus(repo.state,imported.id,'words',word.id),'mastered');
});
test('A malformed import is atomic and leaves the current saved library intact', () => {
  const storage = memory(), repo = makeRepo(storage), before = storage.getItem(ROOM_KEY), backup = JSON.parse(repo.export());
  backup.lessons[0].sentences[1].id = backup.lessons[0].sentences[0].id;
  assert.throws(() => repo.import(backup)); assert.equal(storage.getItem(ROOM_KEY),before); assert.equal(repo.state.lessons.length,1);
  assert.throws(() => validateLesson({ ...STARTER_LESSONS[0], id: '__proto__' }));
  assert.throws(() => validateState({ version:1,lessons:[] }));
});
test('Unavailable storage allows a temporary session and exports all current changes', () => {
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const repo = makeRepo(unavailable); repo.update(state => { state.lessons[0].title = '临时新标题'; });
  assert.ok(repo.warning); assert.equal(JSON.parse(repo.export()).lessons[0].title,'临时新标题');
});
test('Corrupted saved data is preserved for recovery and never overwritten by fallback practice', () => {
  const storage = memory(); storage.setItem(ROOM_KEY,'{broken'); const repo = makeRepo(storage);
  repo.update(state => { state.lessons[0].title = '临时'; });
  assert.equal(storage.getItem(ROOM_KEY),'{broken'); assert.equal(repo.recoveryRaw,'{broken'); assert.ok(repo.warning);
});
test('A second tab cannot silently overwrite newer changes', () => {
  const storage = memory(), first = makeRepo(storage), second = makeRepo(storage);
  first.update(state => { state.lessons[0].title = '第一标签页'; });
  assert.throws(() => second.update(state => { state.lessons[0].title = '旧标签页'; }),{ code:'conflict' });
  assert.equal(makeRepo(storage).state.lessons[0].title,'第一标签页');
});
test('Text self-check ignores case, punctuation and stress while keeping ё distinct and tracking extra words', () => {
  assert.equal(compareRecitation('Меня́ зову́т Анто́н.','меня зовут антон!').exact,true);
  const check = compareRecitation('Я студент второго курса.','Я студент курса сегодня.');
  assert.deepEqual(check.missing,['второго']); assert.deepEqual(check.extra,['сегодня']);
  assert.equal(compareRecitation('её','ее').exact,false);
});
