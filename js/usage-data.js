const fields = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];
const number = (value, max = Number.MAX_SAFE_INTEGER) => value == null ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : (() => { throw new Error('用量数字格式不正确。'); })();
const label = (value, max = 100) => value == null ? null : typeof value === 'string' && value.length <= max ? value.trim() : (() => { throw new Error('用量名称格式不正确。'); })();
function quota(value) {
  if (value == null) return null;
  return { usedPercent: number(value.usedPercent, 1000), windowDurationMins: number(value.windowDurationMins, 525600), resetsAt: number(value.resetsAt, 7258118400) };
}
export function normalizeUsage(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.limits) || !value.limits.length || value.limits.length > 20) throw new Error('没有可读取的额度数据。');
  if (typeof value.sampledAt !== 'string' || !Number.isFinite(Date.parse(value.sampledAt))) throw new Error('同步时间不正确。');
  const seen = new Set();
  const limits = value.limits.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(item.id) || seen.has(item.id)) throw new Error('额度分组不正确。');
    seen.add(item.id);
    let credits = null;
    if (item.credits != null) {
      const balance = item.credits.balance;
      if (balance != null && (typeof balance !== 'string' || !/^\d{1,16}(?:\.\d{1,16})?$/.test(balance))) throw new Error('点数余额格式不正确。');
      credits = { balance: balance ?? null, hasCredits: item.credits.hasCredits === true, unlimited: item.credits.unlimited === true };
    }
    return { id: item.id, name: label(item.name), plan: label(item.plan, 40), primary: quota(item.primary), secondary: quota(item.secondary), credits };
  });
  let activity = null;
  if (value.activity != null) {
    const summary = Object.fromEntries(fields.map(key => [key, number(value.activity.summary?.[key])]));
    let daily = null;
    if (value.activity.daily != null) {
      if (!Array.isArray(value.activity.daily) || value.activity.daily.length > 400) throw new Error('每日用量记录过多。');
      const dates = new Set();
      daily = value.activity.daily.map(item => {
        if (!item || typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(item.date)) || new Date(item.date).toISOString().slice(0, 10) !== item.date || dates.has(item.date)) throw new Error('每日用量日期不正确。');
        dates.add(item.date);
        return { date: item.date, tokens: number(item.tokens) };
      }).sort((a, b) => a.date.localeCompare(b.date));
    }
    activity = { summary, daily };
  }
  // Deliberately select statistical fields; never retain account IDs or credentials.
  return { version: 1, sampledAt: new Date(value.sampledAt).toISOString(), limits, resetsAvailable: number(value.resetsAvailable, 100000), activity };
}
export function usageFromCodex(rates, activity, now = Date.now()) {
  const buckets = rates?.rateLimitsByLimitId && Object.keys(rates.rateLimitsByLimitId).length ? Object.entries(rates.rateLimitsByLimitId) : rates?.rateLimits ? [[rates.rateLimits.limitId || 'codex', rates.rateLimits]] : [];
  return normalizeUsage({
    version: 1, sampledAt: new Date(now).toISOString(),
    limits: buckets.map(([id, item]) => ({ id, name: item.limitName, plan: item.planType, primary: item.primary, secondary: item.secondary, credits: item.credits })),
    resetsAvailable: rates?.rateLimitResetCredits?.availableCount,
    activity: activity ? { summary: activity.summary, daily: activity.dailyUsageBuckets?.map(item => ({ date: item.startDate, tokens: item.tokens })) ?? null } : null
  });
}
export function quotaView(window, now = Date.now()) {
  if (!window) return { remaining: null, expired: false };
  const expired = window.resetsAt != null && window.resetsAt * 1000 <= now;
  return { remaining: expired || window.usedPercent == null ? null : Math.max(0, Math.min(100, 100 - window.usedPercent)), expired };
}
