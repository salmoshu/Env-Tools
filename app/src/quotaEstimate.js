// 配额估算只接受同账号、同来源范围、同窗口的当前样本。
// 当前 token 查询键使用精确 elapsed；相邻时间桶的旧 token 不参与当前反推。
// 外部设备消耗或覆盖不完整时，仅使用通过质量筛选的历史样本。

export const QUOTA_EST_FETCH_BUCKET = 1800;
const QUOTA_ESTIMABLE_MAX_SECONDS = 32 * 86400;
const QUOTA_PROVIDER_KEYS = {
  "Kimi Code": "kimi",
  "OpenAI Codex": "codex",
  GLM: "glm",
};

export function quotaEstimateMeta(provider, w, accountId = "default") {
  const key = QUOTA_PROVIDER_KEYS[provider];
  if (!key) return null;
  if (!(w.used_percent > 0) || !w.window_seconds
    || w.window_seconds > QUOTA_ESTIMABLE_MAX_SECONDS || w.reset_after_seconds == null) {
    return null;
  }
  const elapsed = w.window_seconds - w.reset_after_seconds;
  if (elapsed <= 0) return null;
  return {
    key,
    account: String(accountId || "default"),
    bucket: Math.round(elapsed / QUOTA_EST_FETCH_BUCKET) * QUOTA_EST_FETCH_BUCKET,
    elapsed,
    windowSeconds: w.window_seconds,
  };
}

export function quotaEstimateStoreKey(meta) {
  return `${meta.key}|${meta.account}|${meta.windowSeconds}|${meta.elapsed}`;
}

function quotaEstimateFind(estimates, meta) {
  return estimates[quotaEstimateStoreKey(meta)] ?? null;
}

export function quotaEstimateLookupEntry(estimates, provider, w, accountId = "default") {
  const meta = quotaEstimateMeta(provider, w, accountId);
  return meta ? quotaEstimateFind(estimates, meta) : null;
}

export function quotaEstimateLookup(estimates, provider, w, accountId = "default") {
  const entry = quotaEstimateLookupEntry(estimates, provider, w, accountId);
  return entry && Number.isFinite(entry.tokens) ? entry.tokens : null;
}

function median(points) {
  points.sort((a, b) => a - b);
  const mid = Math.floor(points.length / 2);
  return points.length % 2 ? points[mid] : (points[mid - 1] + points[mid]) / 2;
}

export function quotaEstimateLookupTotal(estimates, provider, w, usedTokens, accountId = "default") {
  const meta = quotaEstimateMeta(provider, w, accountId);
  if (!meta) return null;
  const entry = quotaEstimateFind(estimates, meta);
  if (!entry) return null;
  const points = [];
  const currentUsable = usedTokens > 0
    && entry.usable !== false
    && entry.coverageComplete !== false
    && !entry.externalActivity;
  if (currentUsable) points.push(usedTokens / (Math.max(0.01, w.used_percent) / 100));
  if (Array.isArray(entry.history)) {
    points.push(...entry.history.filter((value) => Number.isFinite(value) && value > 0));
  }
  return points.length ? median(points) : null;
}

export function quotaEstimateQuality(entry) {
  if (!entry) return "pending";
  if (entry.externalActivity) return "external";
  if (entry.coverageComplete === false || entry.failedSources > 0) return "incomplete";
  if (entry.tokens === 0) return "no_usage";
  if (entry.usable === false) return "low_quality";
  return entry.quality || "medium";
}
