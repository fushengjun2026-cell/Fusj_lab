import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NotebookService } from '../server/notebook.js';
import { PasswordNotesStore } from '../js/notes-store.js';
import { validateDocument, encodeDocument, decodeDocument } from '../js/notes-document.js';

const makeNote = (id = 'first', content = '第一段：一个想法。\n\n第二段：中文与 emoji 🌱') => ({ id, title: '学习笔记', category: 'log', content, createdAt: '2026-10-12T01:00:00.000Z', updatedAt: '2026-10-12T01:00:00.000Z' });
function fixture(initial = []) {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(query, ...args) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...args); statement.run(...args); return []; } },
    transactionSync(callback) {
      db.exec('BEGIN');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const env = { NOTES_PASSWORD: 'fixture-password' };
  let now = Date.now();
  let service = new NotebookService(storage, env, { version: 1, notes: initial }, () => now);
  const state = { lostResponse: false, calls: [], advance(ms) { now += ms; }, restart() { service = new NotebookService(storage, env, undefined, () => now); } };
  const request = async (url, options = {}) => {
    state.calls.push({ url, options });
    const req = new Request(url, options);
    req.headers.set('x-notes-client', 'fixture');
    const response = await service.fetch(req);
    if (state.lostResponse && options.method === 'PUT' && response.ok) { state.lostResponse = false; throw new Error('lost response'); }
    return response;
  };
  const storageMap = new Map();
  const browserStorage = { getItem: key => storageMap.get(key) || null, setItem: (key, value) => storageMap.set(key, value), removeItem: key => storageMap.delete(key) };
  const client = () => new PasswordNotesStore('https://notes.test', { request, storage: browserStorage });
  return { db, env, state, service, request, client, browserStorage };
}
const apiRequest = (path, method = 'GET', value, token) => new Request(`https://notes.test/api/${path}`, {
  method, headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(value === undefined ? {} : { body: JSON.stringify(value) })
});

test('Unicode paragraphs survive encoding and malformed/duplicate data is rejected', () => {
  const document = { version: 1, notes: [makeNote()] };
  assert.deepEqual(decodeDocument(encodeDocument(document)), document);
  assert.throws(() => validateDocument({ version: 1, notes: [makeNote(), makeNote()] }));
  assert.throws(() => validateDocument({ version: 2, notes: [] }));
});

test('Public reading works; direct unauthenticated or forged-session writes are rejected', async () => {
  const f = fixture([makeNote()]);
  assert.equal((await (await f.service.fetch(apiRequest('notes'))).json()).document.notes.length, 1);
  for (const token of [undefined, 'a'.repeat(64)]) {
    assert.equal((await f.service.fetch(apiRequest('notes', 'PUT', { note: makeNote('new'), expected: null }, token))).status, 401);
    assert.equal((await f.service.fetch(apiRequest('notes', 'DELETE', { expected: makeNote() }, token))).status, 401);
  }
  assert.equal(f.service.snapshot().document.notes.length, 1);
});

test('Wrong password cannot enter management; repeated attempts are throttled and later recover', async () => {
  const f = fixture();
  const client = f.client();
  for (let i = 0; i < 5; i++) await assert.rejects(client.connect('wrong'), { code: 'password' });
  assert.equal(client.connected, false);
  await assert.rejects(client.connect('fixture-password'), { code: 'rate' });
  f.state.advance(60001);
  await client.connect('fixture-password');
  assert.equal(client.connected, true);
});

test('Password login publishes, edits, and deletes shared notes across independent clients and server restart', async () => {
  const f = fixture();
  const author = f.client();
  await author.connect('fixture-password');
  const note = makeNote();
  await author.save(note);
  f.state.restart();
  assert.deepEqual((await f.client().read()).document.notes, [note]);
  const updated = { ...note, content: '<img src=x onerror=alert(1)>\n只是正文', updatedAt: '2026-10-12T02:00:00.000Z' };
  await author.save(updated, note);
  assert.deepEqual((await f.client().read()).document.notes, [updated]);
  await author.remove(updated);
  assert.deepEqual((await f.client().read()).document.notes, []);
});

test('Refresh restores server-validated session without storing the password; logout revokes it', async () => {
  const f = fixture();
  const author = f.client();
  await author.connect('fixture-password');
  const saved = f.browserStorage.getItem(author.sessionKey);
  assert.equal(saved.includes('fixture-password'), false);
  const token = JSON.parse(saved).token;
  const refreshed = f.client();
  await refreshed.restore();
  assert.equal(refreshed.connected, true);
  await refreshed.disconnect();
  assert.equal(f.browserStorage.getItem(author.sessionKey), null);
  assert.equal((await f.service.fetch(apiRequest('notes', 'PUT', { note: makeNote(), expected: null }, token))).status, 401);
});

test('Expired sessions and password rotation prevent writes and clear stale browser sessions', async () => {
  const f = fixture();
  const client = f.client();
  await client.connect('fixture-password');
  f.state.advance(24 * 60 * 60 * 1000 + 1);
  await assert.rejects(client.save(makeNote()), { code: 'auth' });
  assert.equal(client.connected, false);
  const other = f.client();
  await other.connect('fixture-password');
  f.env.NOTES_PASSWORD = 'changed-password';
  await assert.rejects(f.client().restore(), { code: 'auth' });
  assert.equal(f.browserStorage.getItem(other.sessionKey), null);
  assert.deepEqual(f.service.snapshot().document.notes, []);
});

test('Concurrent unrelated edits survive; stale edits and stale deletes of the same note fail', async () => {
  const original = makeNote();
  const f = fixture([original]);
  const first = f.client(), second = f.client();
  await first.connect('fixture-password'); await second.connect('fixture-password');
  await first.save(makeNote('other'));
  const updated = { ...original, content: '另一位管理者修改了正文' };
  await second.save(updated, original);
  await assert.rejects(first.save({ ...original, title: '过期修改' }, original), { code: 'edited' });
  await assert.rejects(first.remove(original), { code: 'edited' });
  assert.deepEqual((await first.read()).document.notes, [makeNote('other'), updated]);
});

test('A lost publish receipt can be confirmed and retried without duplicate notes or history', async () => {
  const f = fixture();
  const author = f.client();
  await author.connect('fixture-password');
  f.state.lostResponse = true;
  const note = makeNote();
  await author.save(note);
  await author.save(note);
  assert.deepEqual((await f.client().read()).document.notes, [note]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
});

test('Failed SQL writes roll back both the document and its history', async () => {
  const f = fixture([makeNote()]);
  f.db.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON notebook BEGIN SELECT RAISE(ABORT, 'unavailable'); END");
  const author = f.client();
  await author.connect('fixture-password');
  await assert.rejects(author.save(makeNote('new')), { code: 'network' });
  assert.deepEqual(f.service.snapshot().document.notes, [makeNote()]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0);
});

test('Invalid updates and oversized request bodies cannot change published notes', async () => {
  const f = fixture([makeNote()]);
  const author = f.client();
  await author.connect('fixture-password');
  const token = JSON.parse(f.browserStorage.getItem(author.sessionKey)).token;
  const wrongId = { ...makeNote(), id: 'mismatch' };
  assert.equal((await f.service.fetch(apiRequest('notes', 'PUT', { note: wrongId, expected: makeNote() }, token))).status, 400);
  assert.equal((await f.service.fetch(apiRequest('notes', 'PUT', { note: { ...makeNote(), content: 'a'.repeat(1100001) } }, token))).status, 413);
  assert.deepEqual(f.service.snapshot().document.notes, [makeNote()]);
});

test('Missing server configuration fails closed and history requires valid management login', async () => {
  const f = fixture();
  assert.equal((await f.service.fetch(apiRequest('history'))).status, 401);
  delete f.env.NOTES_PASSWORD;
  assert.equal((await f.service.fetch(apiRequest('session', 'POST', { password: 'anything' }))).status, 503);
  const client = new PasswordNotesStore('');
  await assert.rejects(client.connect('anything'), { code: 'setup' });
  assert.throws(() => new PasswordNotesStore('http://insecure.test'), { code: 'setup' });
});
