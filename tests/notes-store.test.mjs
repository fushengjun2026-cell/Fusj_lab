import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubNotesStore, encodeDocument, decodeDocument, validateDocument } from '../js/notes-store.js';

const owner = 'fushengjun2026-cell';
const timestamp = '2026-10-12T01:00:00.000Z';
const makeNote = (id = 'first', content = '第一段：一个想法。\n\n第二段：中文与 emoji 🌱') => ({ id, title: '学习笔记', category: 'log', content, createdAt: timestamp, updatedAt: timestamp });

function fakeGitHub(initial = []) {
  const state = { document: { version: 1, notes: structuredClone(initial) }, sha: 'one', writes: 0, calls: [], owner, denyWrite: false, beforeWrite: null, lostResponse: false };
  const request = async (url, options = {}) => {
    state.calls.push({ url, options });
    assert.ok(url.startsWith('https://api.github.com/'));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    if (url.endsWith('/user')) return Response.json({ login: state.owner });
    if (url.endsWith('/Fusj_lab')) return Response.json({ permissions: { push: true }, private: false });
    if (options.method !== 'PUT') return Response.json({ encoding: 'base64', content: encodeDocument(state.document), sha: state.sha });
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    if (state.denyWrite) return Response.json({}, { status: 403 });
    if (state.beforeWrite) { const handler = state.beforeWrite; state.beforeWrite = null; handler(state); }
    const body = JSON.parse(options.body);
    if (body.sha !== state.sha) return Response.json({}, { status: 409 });
    state.document = decodeDocument(body.content);
    state.sha += '-next';
    state.writes++;
    if (state.lostResponse) { state.lostResponse = false; throw new Error('connection lost after commit'); }
    return Response.json({ content: { sha: state.sha } });
  };
  return { state, request };
}

test('Unicode content and blank lines survive repository encoding', () => {
  const document = { version: 1, notes: [makeNote()] };
  assert.deepEqual(decodeDocument(encodeDocument(document)), document);
});

test('Malformed data and duplicate IDs fail instead of silently dropping notes', () => {
  assert.throws(() => validateDocument({ version: 2, notes: [] }), { code: 'format' });
  assert.throws(() => validateDocument({ version: 1, notes: [makeNote(), makeNote()] }), { code: 'format' });
  assert.throws(() => decodeDocument('not-base64'), { code: 'format' });
});

test('Visitors can read without a token but cannot publish', async () => {
  const { state, request } = fakeGitHub([makeNote()]);
  const reader = new GitHubNotesStore(request);
  assert.equal((await reader.read()).document.notes.length, 1);
  assert.equal(state.calls[0].options.headers.Authorization, undefined);
  await assert.rejects(reader.save(makeNote('new')), { code: 'auth' });
  assert.equal(state.writes, 0);
});

test('Only the repository owner may connect; disconnect removes credentials', async () => {
  const { state, request } = fakeGitHub();
  const store = new GitHubNotesStore(request);
  state.owner = 'someone-else';
  await assert.rejects(store.connect('fixture-token'), { code: 'owner' });
  assert.equal(store.connected, false);
  state.owner = owner;
  await store.connect('fixture-token');
  assert.equal(store.connected, true);
  store.disconnect();
  await store.read();
  assert.equal(state.calls.at(-1).options.headers.Authorization, undefined);
});

test('Create, update, reload on another device, and delete use shared repository data', async () => {
  const { state, request } = fakeGitHub();
  const author = new GitHubNotesStore(request);
  await author.connect('fixture-token');
  const original = makeNote();
  await author.save(original);
  const otherDevice = new GitHubNotesStore(request);
  assert.deepEqual((await otherDevice.read()).document.notes, [original]);
  const updated = { ...original, content: '修改后的内容', updatedAt: '2026-10-12T02:00:00.000Z' };
  await author.save(updated, original);
  assert.deepEqual((await otherDevice.read()).document.notes, [updated]);
  await author.remove(updated);
  assert.equal((await otherDevice.read()).document.notes.length, 0);
  assert.equal(state.writes, 3);
});

test('An unrelated simultaneous edit is preserved after SHA conflict retry', async () => {
  const original = makeNote();
  const { state, request } = fakeGitHub([original]);
  const store = new GitHubNotesStore(request);
  await store.connect('fixture-token');
  state.beforeWrite = state => { state.document.notes.push(makeNote('other-device')); state.sha = 'changed-elsewhere'; };
  await store.save({ ...original, title: '新标题', updatedAt: '2026-10-12T03:00:00.000Z' }, original);
  assert.equal(state.document.notes.length, 2);
  assert.equal(state.document.notes.find(note => note.id === 'other-device').title, '学习笔记');
  assert.equal(state.document.notes.find(note => note.id === 'first').title, '新标题');
});

test('Editing a stale version of the same note never overwrites another device', async () => {
  const original = makeNote();
  const { state, request } = fakeGitHub([original]);
  const store = new GitHubNotesStore(request);
  await store.connect('fixture-token');
  state.document.notes[0].content = '另一台设备写的内容';
  await assert.rejects(store.save({ ...original, content: '过期的修改' }, original), { code: 'edited' });
  assert.equal(state.document.notes[0].content, '另一台设备写的内容');
  assert.equal(state.writes, 0);
});

test('An edit on the same note during a write also fails safely after retry', async () => {
  const original = makeNote();
  const { state, request } = fakeGitHub([original]);
  const store = new GitHubNotesStore(request);
  await store.connect('fixture-token');
  state.beforeWrite = state => { state.document.notes[0].content = '同时编辑'; state.sha = 'concurrent-sha'; };
  await assert.rejects(store.save({ ...original, title: '旧设备新标题' }, original), { code: 'edited' });
  assert.equal(state.document.notes[0].content, '同时编辑');
  assert.equal(state.writes, 0);
});

test('Write permission failures leave published content intact', async () => {
  const original = makeNote();
  const { state, request } = fakeGitHub([original]);
  const store = new GitHubNotesStore(request);
  await store.connect('fixture-token');
  state.denyWrite = true;
  await assert.rejects(store.save({ ...original, title: '改动' }, original), { code: 'permission' });
  assert.deepEqual(state.document.notes, [original]);
});

test('Lost commit responses are confirmed by rereading; retries do not duplicate notes', async () => {
  const { state, request } = fakeGitHub();
  const store = new GitHubNotesStore(request);
  await store.connect('fixture-token');
  state.lostResponse = true;
  const note = makeNote();
  await store.save(note);
  await store.save(note);
  assert.equal(state.writes, 1);
  assert.deepEqual(state.document.notes, [note]);
});

test('A missing initial notes file can be created without a SHA', async () => {
  let published;
  const base = fakeGitHub();
  const request = async (url, options) => {
    if (url.includes('/contents/') && options.method !== 'PUT' && !published) return Response.json({}, { status: 404 });
    if (options.method === 'PUT') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.sha, undefined);
      published = decodeDocument(payload.content);
      return Response.json({ content: { sha: 'created' } });
    }
    return base.request(url, options);
  };
  const store = new GitHubNotesStore(request);
  await store.connect('fixture-token');
  await store.save(makeNote());
  assert.equal(published.notes.length, 1);
});
