// 配额 token 额度估算的元数据与查询（v0.8.3）。
// 服务端百分比是每次估算的校准快照；请求级 token 增量只用于反推窗口总额。
// 缓存键包含账号，避免同 provider 的多账号共用当前值或历史中位数。
// 窗口长度仍按 30 分钟桶做容差查询，但拉取时必须使用 meta.elapsed 原值。

export const QUOTA_EST_FETCH_BUCKET = 1800;
const QUOTA_ESTIMABLE_MAX_SECONDS = 32 * 86400;
const QUOTA_PROVIDER_KEYS = {
  "Kimi Code": "kimi",
  "OpenAI Codex": "codex",
  GLM: "glm",
};

/** 窗口估算元数据；不满足估算条件返回 null */
export function quotaEstimateMeta(provider, w, accountId = "default") {
  const key = QUOTA_PROVIDER_KEYS[provider];
  if (!key) return null;
  if (!(w.used_percent > 0) || !w.window_seconds
    || w.window_seconds > QUOTA_ESTIMABLE_MAX_SECONDS || w.reset_after_seconds == null) {
    return null;
  }
  const elapsed = Math.max(600, w.window_seconds - w.reset_after_seconds);
  return {
    key,
    account: String(accountId || "default"),
    bucket: Math.round(elapsed / QUOTA_EST_FETCH_BUCKET) * QUOTA_EST_FETCH_BUCKET,
    elapsed,
    windowSeconds: w.window_seconds,
  };
}

/** 估算条目的存储/查询键：provider|account|window_seconds|bucket */
export function quotaEstimateStoreKey(meta) {
  return `${meta.key}|${meta.account}|${meta.windowSeconds}|${meta.bucket}`;
}

function quotaEstimateFind(estimates, meta) {
  for (const offset of [0, -1, 1, -2, 2]) {
    const v = estimates[`${meta.key}|${meta.account}|${meta.windowSeconds}|${meta.bucket + offset * QUOTA_EST_FETCH_BUCKET}`];
    if (v != null) return v;
  }
  return null;
}

/** 查询完整估算条目，包含 tokens、来源覆盖数与历史校准值 */
export function quotaEstimateLookupEntry(estimates, provider, w, accountId = "default") {
  const meta = quotaEstimateMeta(provider, w, accountId);
  return meta ? quotaEstimateFind(estimates, meta) : null;
}

/** 查询窗口内已记录的请求级 token 用量 */
export function quotaEstimateLookup(estimates, provider, w, accountId = "default") {
  const entry = quotaEstimateLookupEntry(estimates, provider, w, accountId);
  return entry && Number.isFinite(entry.tokens) ? entry.tokens : null;
}

/** 当前快照与相同账号的历史高水位合并取中位数；无增量时不用 0 反推 */
export function quotaEstimateLookupTotal(estimates, provider, w, usedTokens, accountId = "default") {
  if (!(usedTokens > 0)) return null;
  const meta = quotaEstimateMeta(provider, w, accountId);
  if (!meta) return null;
  const entry = quotaEstimateFind(estimates, meta);
  if (!entry) return null;
  const pct = Math.max(0.01, w.used_percent);
  const points = [usedTokens / (pct / 100)];
  if (Array.isArray(entry.history)) {
    points.push(...entry.history.filter((x) => Number.isFinite(x) && x > 0));
  }
  points.sort((a, b) => a - b);
  const mid = Math.floor(points.length / 2);
  return points.length % 2 ? points[mid] : (points[mid - 1] + points[mid]) / 2;
}
