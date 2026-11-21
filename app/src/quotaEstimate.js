// 配额 token 额度估算的元数据与查询（v0.8.2）。
// 厂商只公布已用百分比：估算总额 = 窗口 elapsed 时段内的实际 token ÷ 已用%。
//
// 存储键必须同时包含 provider、窗口长度与 30 分钟桶：
// Codex 的 5h 与 7d 窗口在配额联合重置后会拥有相同的 elapsed（窗口起点相同），
// 若键里没有 window_seconds，两个窗口会落到同一个条目——后拉取的 7d 估算
// （含 7d 历史中位）被 5h 行复用，表现为两行显示完全相同的 已用/≈总额。

export const QUOTA_EST_FETCH_BUCKET = 1800;
// 估算范围含 5h/7d 与月度（≤32d，Kimi Monthly Total 也支持 token 显示）
const QUOTA_ESTIMABLE_MAX_SECONDS = 32 * 86400;
const QUOTA_PROVIDER_KEYS = {
  "Kimi Code": "kimi",
  "OpenAI Codex": "codex",
  GLM: "glm",
};

/** 窗口估算元数据：{ key, bucket(30 分钟桶), elapsed, windowSeconds }；不满足估算条件返回 null */
export function quotaEstimateMeta(provider, w) {
  const key = QUOTA_PROVIDER_KEYS[provider];
  if (!key) return null;
  if (!(w.used_percent > 0) || !w.window_seconds
    || w.window_seconds > QUOTA_ESTIMABLE_MAX_SECONDS || w.reset_after_seconds == null) {
    return null;
  }
  const elapsed = Math.max(600, w.window_seconds - w.reset_after_seconds);
  return {
    key,
    bucket: Math.round(elapsed / QUOTA_EST_FETCH_BUCKET) * QUOTA_EST_FETCH_BUCKET,
    elapsed,
    windowSeconds: w.window_seconds,
  };
}

/** 估算条目的存储/查询键：provider|window_seconds|bucket */
export function quotaEstimateStoreKey(meta) {
  return `${meta.key}|${meta.windowSeconds}|${meta.bucket}`;
}

/** 容差查询：精确桶 → ±1、±2 桶（同一窗口长度内），命中即返回最近拉取结果 */
export function quotaEstimateLookup(estimates, provider, w) {
  const meta = quotaEstimateMeta(provider, w);
  if (!meta) return null;
  for (const offset of [0, -1, 1, -2, 2]) {
    const v = estimates[`${meta.key}|${meta.windowSeconds}|${meta.bucket + offset * QUOTA_EST_FETCH_BUCKET}`];
    if (v != null) return v.tokens;
  }
  return null;
}

/** 查询估算总额（含历史中位）：返回 median(历史各代 + 当前单点) 或 null */
export function quotaEstimateLookupTotal(estimates, provider, w, usedTokens) {
  const meta = quotaEstimateMeta(provider, w);
  if (!meta) return null;
  for (const offset of [0, -1, 1, -2, 2]) {
    const v = estimates[`${meta.key}|${meta.windowSeconds}|${meta.bucket + offset * QUOTA_EST_FETCH_BUCKET}`];
    if (v != null) {
      const pct = Math.max(0.01, w.used_percent);
      const points = [usedTokens / (pct / 100)];
      if (Array.isArray(v.history)) {
        points.push(...v.history.filter((x) => Number.isFinite(x) && x > 0));
      }
      points.sort((a, b) => a - b);
      const mid = Math.floor(points.length / 2);
      return points.length % 2 ? points[mid] : (points[mid - 1] + points[mid]) / 2;
    }
  }
  return null;
}
