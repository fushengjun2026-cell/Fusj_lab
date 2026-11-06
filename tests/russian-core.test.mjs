import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_KEY, RoomRepository, parsePassage, validateLesson, validateState, normalizeRussian, speechText, transliterate, setProgress, progressStatus, compareRecitation, comparePassage, punctuateDictation } from '../js/russian-core.js';
import { STARTER_LESSONS } from '../js/russian-lessons.js';
import { ADDED_LESSONS } from '../js/russian-new-lesson.js';
import { DIALOGUE_LESSONS } from '../js/russian-dialogues.js';
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


test('New textbook passage includes all original sentences, translations and vocabulary', () => {
  const lesson = validateLesson(ADDED_LESSONS[0]);
  assert.equal(lesson.sentences.length, 14);
  assert.equal(lesson.vocabulary.length, 23);
  assert.ok(lesson.sentences.every(sentence => sentence.translation && sentence.keywords.length));
  assert.ok(lesson.sentences[0].text.startsWith('Вчера́ я был'));
  assert.ok(lesson.sentences.at(-1).text.endsWith('познако́мился с ней.'));
});

test('Adding the textbook lesson preserves existing edits and progress, and respects later deletion', () => {
  const storage = memory(), old = makeRepo(storage), original = old.state.lessons[0];
  old.update(state => { state.lessons[0].title = '我的原有课文'; setProgress(state, original.id, 'sentences', original.sentences[0].id, 'mastered'); });
  const updated = new RoomRepository(storage, STARTER_LESSONS, ADDED_LESSONS);
  assert.equal(updated.state.lessons.length, 2);
  assert.equal(updated.state.lessons[0].title, '我的原有课文');
  assert.equal(progressStatus(updated.state, original.id, 'sentences', original.sentences[0].id), 'mastered');
  assert.equal(updated.state.lessons[1].id, ADDED_LESSONS[0].id);
  updated.update(state => { state.lessons = state.lessons.filter(lesson => lesson.id !== ADDED_LESSONS[0].id); });
  assert.equal(new RoomRepository(storage, STARTER_LESSONS, ADDED_LESSONS).state.lessons.length, 1);
});

test('Adding the textbook lesson does not overwrite an existing lesson with the same id', () => {
  const storage = memory(), old = makeRepo(storage);
  old.update(state => { state.lessons.push({ ...structuredClone(ADDED_LESSONS[0]), title: '已编辑的课文' }); });
  const updated = new RoomRepository(storage, STARTER_LESSONS, ADDED_LESSONS);
  assert.equal(updated.state.lessons.length, 2);
  assert.equal(updated.state.lessons[1].title, '已编辑的课文');
});

test('Every word in the supplied lessons has an offline contextual gloss', async () => {
  const { lookupRussianWord } = await import('../js/russian-dictionary.js');
  for (const lesson of [...STARTER_LESSONS, ...ADDED_LESSONS]) {
    for (const sentence of lesson.sentences) {
      for (const word of normalizeRussian(sentence.text).match(/\p{Script=Cyrillic}[\p{Script=Cyrillic}\p{M}]*/gu) || []) {
        const gloss = lookupRussianWord(word);
        assert.ok(gloss?.part && gloss?.meaning, `Missing gloss for ${word}`);
      }
    }
  }
  assert.equal(lookupRussianWord('бра́та').lemma, 'брат');
  assert.equal(lookupRussianWord('несуществующееслово'), null);
});

test('Full-passage comparison checks beyond the sentence limit and reports truncation explicitly', () => {
  const words = Array.from({ length: 500 }, (_, i) => `слово${i}`);
  const full = words.join(' ');
  const changed = [...words]; changed[420] = 'другое';
  const sentenceLimit = compareRecitation(full, changed.join(' '));
  assert.equal(sentenceLimit.truncated, true);
  const whole = compareRecitation(full, changed.join(' '), 2500);
  assert.equal(whole.truncated, false);
  assert.equal(whole.exact, false);
  assert.deepEqual(whole.missing, ['слово420']);
  assert.deepEqual(whole.extra, ['другое']);
  assert.equal(compareRecitation(full, full, 2500).exact, true);
  assert.equal(compareRecitation(full, full, 100).truncated, true);
});


test('Full passage aligns individual sentences and marks only extra input spans', () => {
  const sentences = ['Вчера́ я был дома.', 'Она́ читает книгу.', 'Мне интересно.'];
  const actual = 'Вчера я был дома. Она читает газету. Мне интересно!';
  const result = comparePassage(sentences, actual);
  assert.deepEqual(result.sentenceStatus, ['matched', 'incomplete', 'matched']);
  assert.deepEqual(result.missing, ['книгу']);
  assert.deepEqual(result.extra, ['газету']);
  assert.equal(actual.slice(result.extraRanges[0].start, result.extraRanges[0].end), 'газету');
});

test('Passage comparison preserves accents and offsets and does not mark sentences with inserted words correct', () => {
  const actual = 'Я о́чень люблю ёлку и снег.';
  const result = comparePassage(['Я люблю ёлку.', 'И снег.'], actual);
  assert.deepEqual(result.sentenceStatus, ['incomplete', 'matched']);
  assert.equal(actual.slice(result.extraRanges[0].start, result.extraRanges[0].end), 'о́чень');
  assert.equal(comparePassage(['Я люблю ёлку.'], 'Я люблю елку.').exact, false);
  assert.equal(comparePassage(['Я люблю ёлку.'], 'я люблю ёлку!').exact, true);
});

test('Passage comparison reports unexamined sentences beyond its limit', () => {
  const result = comparePassage(['Раз два.', 'Три четыре.'], 'Раз два три четыре', 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.sentenceStatus, ['matched', 'unchecked']);
  assert.equal(result.exact, false);
});


test('Russian dictation fills punctuation from matched words without changing the words', () => {
  const original = 'Вчера́ я был в гостя́х. Она́ сказала: «Приве́т, Анна!»';
  assert.equal(punctuateDictation(original, '', 'вчера я был в гостях она сказала привет анна'), 'вчера я был в гостях. она сказала: привет, анна!');
  assert.equal(punctuateDictation(original, 'вчера я был в гостях. ', 'она сказала привет анна'), 'она сказала: привет, анна!');
  assert.equal(punctuateDictation(original, '', 'вчера я был в гостях! она сказала привет анна'), 'вчера я был в гостях! она сказала: привет, анна!');
  assert.equal(punctuateDictation(original, '', 'вчера я был в гостях', '.'), 'вчера я был в гостях');
  assert.equal(punctuateDictation(original, '', 'вчера я был дома она сказала'), 'вчера я был дома она сказала');
  assert.equal(punctuateDictation(original, 'ошибка', 'она сказала'), 'она сказала');
});


test('Both textbook dialogues include the complete text, roles, translations and vocabulary', async () => {
  const [appearance, character] = DIALOGUE_LESSONS.map(validateLesson);
  assert.equal(appearance.sentences.length, 20); assert.equal(character.sentences.length, 19);
  assert.deepEqual([...new Set(appearance.sentences.map(s => speechText(s.speaker)))], ['Саша', 'Антон']);
  assert.deepEqual([...new Set(character.sentences.map(s => speechText(s.speaker)))], ['Мама', 'Анна']);
  assert.ok(character.sentences.some(s => speechText(s.text) === 'Да, но я считаю, что вы очень разные по характеру.'));
  assert.equal(speechText(character.sentences.at(-1).text), 'Нет, с ней вместе и я стала общительнее.');
  assert.ok([...appearance.sentences, ...character.sentences].every(s => s.translation && s.keywords.length));
  const { lookupRussianWord } = await import('../js/russian-dictionary.js');
  for (const item of [appearance, character]) for (const sentence of item.sentences) for (const word of sentence.text.match(/\p{Script=Cyrillic}[\p{Script=Cyrillic}\p{M}]*/gu) || []) assert.ok(lookupRussianWord(word, item.id), word);
  assert.equal(lookupRussianWord('ли', 'dialogue-appearance').part, '语气词');
  assert.equal(lookupRussianWord('ли', 'classroom-introduction').part, '专有名词');
});

test('New dialogues arrive in an existing library without overwriting edits, progress or deletions', () => {
  const storage = memory(), old = new RoomRepository(storage, STARTER_LESSONS, ADDED_LESSONS);
  const first = old.state.lessons[0];
  old.update(state => { state.lessons[0].title = '已编辑'; setProgress(state, first.id, 'sentences', first.sentences[0].id, 'mastered'); });
  const updated = new RoomRepository(storage, STARTER_LESSONS, [...ADDED_LESSONS, ...DIALOGUE_LESSONS]);
  assert.equal(updated.state.lessons.length, 4); assert.equal(updated.state.lessons[0].title, '已编辑');
  assert.equal(progressStatus(updated.state, first.id, 'sentences', first.sentences[0].id), 'mastered');
  updated.update(state => { state.lessons = state.lessons.filter(item => item.id !== DIALOGUE_LESSONS[0].id); });
  const restored = new RoomRepository(storage, STARTER_LESSONS, [...ADDED_LESSONS, ...DIALOGUE_LESSONS]);
  assert.equal(restored.state.lessons.length, 3); assert.equal(restored.state.lessons.some(item => item.id === DIALOGUE_LESSONS[0].id), false);
});
