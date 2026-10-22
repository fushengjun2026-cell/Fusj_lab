import { normalizeUsage } from '../js/usage-data.js';
import { NotesError } from '../js/notes-document.js';

export class CodexUsage {
  constructor(storage, now = Date.now) {
    this.storage = storage; this.sql = storage.sql; this.now = now;
    this.sql.exec('CREATE TABLE IF NOT EXISTS codex_usage (id INTEGER PRIMARY KEY, document TEXT NOT NULL, received_at TEXT NOT NULL)');
  }
  read() {
    const row = Array.from(this.sql.exec('SELECT document, received_at FROM codex_usage WHERE id = 1'))[0];
    return row ? { snapshot: normalizeUsage(JSON.parse(row.document)), receivedAt: row.received_at } : { snapshot: null, receivedAt: null };
  }
  save(value) {
    let snapshot;
    try { snapshot = normalizeUsage(value); } catch (error) { throw new NotesError(error.message, 'format'); }
    const sampled = Date.parse(snapshot.sampledAt), now = this.now();
    if (sampled > now + 120000 || sampled < now - 900000) throw new NotesError('同步时间与服务器不一致，请检查电脑时间。', 'format');
    return this.storage.transactionSync(() => {
      const current = this.read();
      if (current.snapshot && sampled < Date.parse(current.snapshot.sampledAt)) throw new NotesError('已保留更新的用量记录。', 'edited');
      this.sql.exec('INSERT INTO codex_usage (id, document, received_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document, received_at = excluded.received_at', JSON.stringify(snapshot), new Date(now).toISOString());
      return { ok: true, sampledAt: snapshot.sampledAt };
    });
  }
}
