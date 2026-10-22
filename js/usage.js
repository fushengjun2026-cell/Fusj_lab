import { PasswordNotesStore } from './notes-store.js?v=4';
import { NOTES_API_URL } from './notes-config.js';
import { normalizeUsage, quotaView } from './usage-data.js?v=1';

const $ = id => document.getElementById(id);
const el = (tag, className = '', text = '') => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
let sessionStorageSafe = null;
try { sessionStorageSafe = sessionStorage; } catch {}
const store = new PasswordNotesStore(NOTES_API_URL, { storage: sessionStorageSafe });
let snapshot = null, busy = false, networkError = '', days = 30, generation = 0;
const format = value => value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
const compact = value => value == null ? '—' : value >= 1e8 ? `${format(value / 1e8)} 亿` : value >= 1e4 ? `${format(value / 1e4)} 万` : format(value);
const dateTime = value => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(value));
function authenticated(value) {
  generation++; busy = false;
  $('usage-access').hidden = value; $('usage-dashboard').hidden = !value;
  if (!value) { snapshot = null; $('quota-grid').replaceChildren(); $('activity-summary').replaceChildren(); $('activity-chart').replaceChildren(); $('usage-daily-table').replaceChildren(); $('usage-extras').replaceChildren(); $('usage-values').hidden = true; $('sync-time').textContent = '—'; $('activity-caption').textContent = ''; $('usage-plan').textContent = 'Codex'; }
}
function notice(text) { $('usage-error').textContent = text; $('usage-error').hidden = !text; }
function fresh() { return snapshot && Date.now() - Date.parse(snapshot.sampledAt) <= 180000; }
function freshness() {
  if (!snapshot) { $('sync-status').textContent = '等待本机同步'; $('sync-time').textContent = '尚无同步记录'; return; }
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.sampledAt)) / 60000));
  const recent = fresh() && !networkError;
  $('sync-status').textContent = networkError ? '连接暂时中断' : recent ? '已收到本机最新同步' : '显示上次同步记录';
  $('sync-badge').classList.toggle('is-stale', !recent);
  $('sync-time').textContent = `最后同步：${dateTime(snapshot.sampledAt)}（北京时间） · ${age < 1 ? '刚刚' : age < 60 ? `${age} 分钟前` : `${format(age / 60)} 小时前`}`;
}
function countdown(timestamp) {
  if (timestamp == null) return '暂未提供';
  const minutes = Math.max(0, Math.ceil((timestamp * 1000 - Date.now()) / 60000));
  if (!minutes) return '等待新周期数据';
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后` : `${minutes} 分钟后`;
}
function quotaTitle(window, secondary) {
  const duration = window?.windowDurationMins;
  return duration === 10080 ? '每周额度' : duration == null ? secondary ? '长周期额度' : '短周期额度' : duration >= 1440 ? `${format(duration / 1440)} 天额度` : duration >= 60 ? `${format(duration / 60)} 小时额度` : `${format(duration)} 分钟额度`;
}
function quotaCard(group, window, secondary) {
  const view = quotaView(window), card = el('article', `quota-card${view.remaining != null && view.remaining < 20 ? ' is-low' : ''}`);
  const top = el('div', 'quota-topline'); top.append(el('span', '', quotaTitle(window, secondary)), el('span', '', group.name || (group.id === 'codex' ? 'Codex' : group.id)));
  const count = el('div', 'quota-number'); count.append(el('strong', '', view.remaining == null ? '—' : `${format(view.remaining)}%`), el('span', '', fresh() ? '剩余' : '上次剩余'));
  card.append(top, count);
  if (view.remaining != null) { const progress = el('progress'); progress.max = 100; progress.value = view.remaining; progress.setAttribute('aria-label', `${quotaTitle(window, secondary)}剩余 ${format(view.remaining)}%`); card.append(progress); }
  else card.append(el('p', 'quota-pending', view.expired ? '上次记录的周期已结束，等待本机同步。' : '账号暂未返回这个周期的剩余额度。'));
  const detail = el('dl', 'quota-detail');
  for (const [key, value] of [[fresh() && !view.expired ? '已使用' : '上次已使用', window?.usedPercent == null ? '暂未提供' : `${format(window.usedPercent)}%`], ['重置时间', window?.resetsAt == null ? '暂未提供' : `${dateTime(window.resetsAt * 1000)}（北京）`], ['距离重置', countdown(window?.resetsAt)]]) {
    const row = el('div'); row.append(el('dt', '', key), el('dd', '', value)); detail.append(row);
  }
  card.append(detail); return card;
}
function renderQuotas() {
  $('quota-grid').replaceChildren(...snapshot.limits.flatMap(group => [quotaCard(group, group.primary, false), ...(group.secondary ? [quotaCard(group, group.secondary, true)] : [])]));
  $('usage-extras').replaceChildren();
  const first = snapshot.limits.find(group => group.id === 'codex') || snapshot.limits[0];
  const plans = { plus: 'Plus', pro: 'Pro', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };
  $('usage-plan').textContent = first.plan ? `Codex · ${plans[first.plan] || first.plan}` : 'Codex';
  const extras = [];
  if (first.credits) extras.push(['账户点数余额', first.credits.unlimited ? '不限量' : first.credits.balance == null ? '暂未提供' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(Number(first.credits.balance))]);
  if (snapshot.resetsAvailable != null) extras.push(['可用额度重置次数', `${format(snapshot.resetsAvailable)} 次`]);
  for (const [label, value] of extras) { const item = el('div', 'usage-extra'); item.append(el('span', '', label), el('strong', '', value)); $('usage-extras').append(item); }
  $('usage-extras').hidden = !extras.length;
}
function renderActivity() {
  const summary = snapshot.activity?.summary;
  const values = [['累计 Token', compact(summary?.lifetimeTokens), summary?.lifetimeTokens == null ? '账号暂未提供' : `${format(summary.lifetimeTokens)} Token`], ['单日最高 Token', compact(summary?.peakDailyTokens), summary?.peakDailyTokens == null ? '账号暂未提供' : `${format(summary.peakDailyTokens)} Token`], ['当前连续使用', summary?.currentStreakDays == null ? '—' : `${format(summary.currentStreakDays)} 天`, '按账号活动记录统计'], ['最长连续使用', summary?.longestStreakDays == null ? '—' : `${format(summary.longestStreakDays)} 天`, '保持自己的节奏']];
  $('activity-summary').replaceChildren(...values.map(([name, value, help]) => { const item = el('div', 'activity-stat'); item.append(el('span', '', name), el('strong', '', value), el('small', '', help)); return item; }));
  renderChart();
}
function renderChart() {
  for (const button of document.querySelectorAll('[data-days]')) button.setAttribute('aria-pressed', String(Number(button.dataset.days) === days));
  const daily = snapshot.activity?.daily || [], latest = daily.at(-1)?.date;
  const since = latest ? new Date(Date.parse(latest) - (days - 1) * 86400000).toISOString().slice(0, 10) : '';
  const visible = daily.filter(row => row.date >= since), available = visible.filter(row => row.tokens != null);
  $('activity-chart').replaceChildren(); $('chart-dates').replaceChildren(); $('usage-daily-table').replaceChildren();
  $('usage-table-details').hidden = !visible.length;
  if (!available.length) { $('activity-chart').append(el('p', '', '账号暂未返回这段时间的每日用量记录。')); $('activity-caption').textContent = '收到用量详情后，这里会显示真实的日记录。'; return; }
  const total = available.reduce((sum, row) => sum + row.tokens, 0);
  $('activity-caption').textContent = `截至 ${latest}，近 ${days} 天共 ${compact(total)} Token · ${available.length} 个记录日`;
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 900 180'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `每日 Token 用量，共 ${format(total)}，下方可展开每日明细。`);
  const peak = Math.max(1, ...available.map(row => row.tokens)), gap = 900 / days;
  for (let i = 0; i < 4; i++) { const line = document.createElementNS(ns, 'line'); for (const [key, value] of Object.entries({ x1: 0, x2: 900, y1: 18 + i * 50, y2: 18 + i * 50, stroke: '#ece4da', 'stroke-width': 1 })) line.setAttribute(key, value); svg.append(line); }
  for (const row of available) {
    const index = Math.round((Date.parse(row.date) - Date.parse(since)) / 86400000), height = row.tokens === 0 ? 1 : Math.max(2, row.tokens / peak * 150);
    const bar = document.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({ x: index * gap + gap * .15, y: 168 - height, width: gap * .7, height, rx: Math.min(4, gap * .15), fill: row.date === latest ? '#8160a5' : '#c8b4db' })) bar.setAttribute(key, value);
    const title = document.createElementNS(ns, 'title'); title.textContent = `${row.date}：${format(row.tokens)} Token`; bar.append(title); svg.append(bar);
  }
  $('activity-chart').append(svg); $('chart-dates').append(el('span', '', since), el('span', '', latest));
  for (const row of [...visible].reverse()) { const tr = el('tr'); tr.append(el('td', '', row.date), el('td', '', format(row.tokens))); $('usage-daily-table').append(tr); }
}
async function refresh() {
  if (busy || !store.connected) return;
  const currentGeneration = generation;
  busy = true; $('refresh-usage').disabled = true;
  try {
    const result = await store.readUsage();
    if (currentGeneration !== generation) return;
    snapshot = result.snapshot ? normalizeUsage(result.snapshot) : null;
    networkError = ''; notice(''); $('usage-empty').hidden = !!snapshot; $('usage-values').hidden = !snapshot;
    if (snapshot) { renderQuotas(); renderActivity(); }
    freshness();
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (error.code === 'auth') { authenticated(false); $('usage-login-status').textContent = '登录已过期，请重新输入管理密码。'; }
    else { networkError = error.message; notice(error.message); freshness(); }
  } finally { if (currentGeneration === generation) { busy = false; $('refresh-usage').disabled = false; } }
}
$('usage-login').addEventListener('submit', async event => {
  event.preventDefault(); $('usage-login-button').disabled = true; $('usage-login-status').textContent = '正在验证……';
  try { await store.connect($('usage-password').value); $('usage-password').value = ''; $('usage-login-status').textContent = ''; authenticated(true); await refresh(); }
  catch (error) { $('usage-login-status').textContent = error.message; }
  finally { $('usage-login-button').disabled = false; }
});
$('refresh-usage').addEventListener('click', refresh);
$('usage-logout').addEventListener('click', async () => { authenticated(false); $('usage-password').value = ''; $('usage-login-status').textContent = ''; await store.disconnect(); });
for (const button of document.querySelectorAll('[data-days]')) button.addEventListener('click', () => { days = Number(button.dataset.days); if (snapshot) renderChart(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 30000);
setInterval(() => { if (snapshot && !document.hidden) { freshness(); renderQuotas(); } }, 60000);
try { if (await store.restore()) { authenticated(true); await refresh(); } } catch (error) { $('usage-login-status').textContent = error.message; }
