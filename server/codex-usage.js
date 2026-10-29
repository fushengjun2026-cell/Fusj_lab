import { normalizeUsage, mergeUsageActivity } from '../js/usage-data.js';
import { NotesError } from '../js/notes-document.js';

export class CodexUsage {
  constructor(storage, now = Date.now) {
    this.storage = storage; this.sql = storage.sql; this.now = now;
    this.sql.exec('CREATE TABLE IF NOT EXISTS codex_usage (id INTEGER PRIMARY KEY, document TEXT NOT NULL, received_at TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS codex_usage_control (id INTEGER PRIMARY KEY, document TEXT NOT NULL)');
  }
  read() {
    const row = Array.from(this.sql.exec('SELECT document, received_at FROM codex_usage WHERE id = 1'))[0];
    const control = this.control();
    const refresh = control.refresh ? { ...control.refresh } : null;
    if (refresh) delete refresh.lease;
    return { snapshot: row ? normalizeUsage(JSON.parse(row.document)) : null, receivedAt: row?.received_at || null, refresh, agentSeenAt: control.agentSeenAt };
  }
  normalize(value) {
    let snapshot;
    try { snapshot = normalizeUsage(value); } catch (error) { throw new NotesError(error.message, 'format'); }
    const sampled = Date.parse(snapshot.sampledAt), now = this.now();
    if (sampled > now + 120000 || sampled < now - 900000) throw new NotesError('同步时间与服务器不一致，请检查电脑时间。', 'format');
    return snapshot;
  }
  persistSnapshot(snapshot) {
    const row = Array.from(this.sql.exec('SELECT document FROM codex_usage WHERE id = 1'))[0];
    const previous = row ? normalizeUsage(JSON.parse(row.document)) : null;
    if (previous && Date.parse(snapshot.sampledAt) < Date.parse(previous.sampledAt)) throw new NotesError('已保留更新的用量记录。', 'edited');
    snapshot.activity = mergeUsageActivity(previous?.activity, snapshot.activity);
    this.sql.exec('INSERT INTO codex_usage (id, document, received_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document, received_at = excluded.received_at', JSON.stringify(snapshot), new Date(this.now()).toISOString());
    return { ok: true, sampledAt: snapshot.sampledAt };
  }
  save(value) {
    const snapshot = this.normalize(value);
    return this.storage.transactionSync(() => this.persistSnapshot(snapshot));
  }
  control() {
    const row = Array.from(this.sql.exec('SELECT document FROM codex_usage_control WHERE id = 1'))[0];
    const control = row ? JSON.parse(row.document) : { agentSeenAt: null, refresh: null };
    if (['pending', 'running'].includes(control.refresh?.status) && Date.parse(control.refresh.expiresAt) <= this.now()) {
      control.refresh.status = 'failed'; control.refresh.finishedAt = new Date(this.now()).toISOString();
      control.refresh.message = '电脑未及时响应，本次刷新已结束。请确认电脑开机联网后再点刷新。';
      this.persistControl(control);
    }
    return control;
  }
  persistControl(control) {
    this.sql.exec('INSERT INTO codex_usage_control (id, document) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document', JSON.stringify(control));
  }
  requestRefresh() {
    return this.storage.transactionSync(() => {
      const control = this.control();
      if (!['pending', 'running'].includes(control.refresh?.status)) {
        const window = control.refreshWindow;
        if (!window || this.now() - window.starts >= 60000) control.refreshWindow = { starts: this.now(), count: 0 };
        if (control.refreshWindow.count >= 6) throw new NotesError('刷新较频繁，请稍等片刻再试。', 'rate');
        control.refreshWindow.count++;
        control.refresh = { id: crypto.randomUUID(), status: 'pending', requestedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 120000).toISOString(), startedAt: null, finishedAt: null, message: null };
        this.persistControl(control);
      }
      const { lease, ...refresh } = control.refresh;
      return { refresh, agentSeenAt: control.agentSeenAt };
    });
  }
  claimRefresh() {
    return this.storage.transactionSync(() => {
      const control = this.control();
      control.agentSeenAt = new Date(this.now()).toISOString();
      let request = null;
      if (control.refresh?.status === 'pending') {
        control.refresh.status = 'running'; control.refresh.startedAt = control.agentSeenAt;
        control.refresh.lease = crypto.randomUUID();
        request = { id: control.refresh.id, lease: control.refresh.lease };
      }
      this.persistControl(control);
      // Return only the task ID and delivery credential to the local reader.
      return { request };
    });
  }
  completeRefresh(value) {
    if (!value || !['success', 'partial', 'failed'].includes(value.status)) throw new NotesError('刷新结果格式不正确。', 'format');
    const snapshot = value.status === 'failed' ? null : this.normalize(value.snapshot);
    return this.storage.transactionSync(() => {
      const control = this.control(), refresh = control.refresh;
      if (!refresh || value.id !== refresh.id || value.lease !== refresh.lease) throw new NotesError('刷新请求已失效。', 'edited');
      if (['success', 'partial', 'failed'].includes(refresh.status) && refresh.finishedAt && refresh.status === value.status) return { ok: true };
      if (refresh.status !== 'running') throw new NotesError('刷新请求已结束，请重新点击刷新。', 'edited');
      if (snapshot) this.persistSnapshot(snapshot);
      refresh.status = value.status; refresh.finishedAt = new Date(this.now()).toISOString();
      refresh.message = value.status === 'success' ? '已重新读取账号的额度和每日 Token 统计。' : value.status === 'failed' ? '账号接口暂时没有返回可用数据，已保留上次记录。可稍后手动重试。' : value.reason === 'rates' ? '账号返回了部分统计，未返回的额度或明细保留上次记录。' : '额度已更新，每日明细暂未返回，保留上次统计。';
      control.agentSeenAt = refresh.finishedAt; this.persistControl(control);
      return { ok: true };
    });
  }
}
