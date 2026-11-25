// 容量校准与本地已观测用量分开。校准值可跨同套餐的快照保留，
// 但本地 token 数只能用于与服务端百分比精确对齐的那个快照。

const QUOTA_ESTIMABLE_MAX_SECONDS = 32 * 86400;
const MONTH = 30 * 86400;
const QUOTA_PROVIDER_KEYS = {
  "Kimi Code": "kimi",
  "OpenAI Codex": "codex",
  GLM: "glm",
};

export function quotaEstimateMeta(provider, w, accountId = "default", plan = "") {
  const key = QUOTA_PROVIDER_KEYS[provider];
  const windowSeconds = w?.window_seconds;
  const reset = w?.reset_after_seconds;
  const pct = w?.used_percent;
  if (!key || !Number.isInteger(windowSeconds) || windowSeconds <= 0 || windowSeconds > QUOTA_ESTIMABLE_MAX_SECONDS
    || !Number.isInteger(reset) || reset < 0 || reset > windowSeconds || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    return null;
  }
  const monthly = windowSeconds >= 27 * 86400;
  const formattedShare = String(w.sub || "").match(/^Kimi Code share:\s*([\d.]+)%$/i);
  const share = w.quota_share_percent ?? (formattedShare ? Number(formattedShare[1]) : null);
  return {
    key,
    account: String(accountId || "default"),
    plan: String(plan || ""),
    elapsed: windowSeconds - reset,
    windowSeconds,
    windowKey: monthly ? MONTH : windowSeconds,
    share: key === "kimi" && monthly && Number.isFinite(share) && share >= 0 && share <= 100 ? share : null,
    pct,
  };
}

export function quotaEstimateStoreKey(meta) {
  return JSON.stringify([meta.key, meta.account, meta.plan, meta.windowKey, meta.share != null]);
}

export function quotaEstimateRequest(account, w, id) {
  const meta = quotaEstimateMeta(account.provider, w, id, account.plan);
  const at = Math.floor(Date.parse(account.fetched_at) / 1000);
  return meta && Number.isFinite(at) && at > 0 ? { ...meta, at, storeKey: quotaEstimateStoreKey(meta) } : null;
}

function validCapacity(capacity) {
  return capacity && Number.isFinite(capacity.total) && capacity.total > 0;
}

export function quotaEstimateResult(query, result) {
  let capacity = validCapacity(result.estimate) ? result.estimate : null;
  // Older SSH agents return history without a fitted model. Reuse their
  // history at low confidence only, without inventing a ratio from a live point.
  if (!Object.hasOwn(result, "estimate") && query.share == null && Array.isArray(result.history)) {
    const history = result.history.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    const mid = history.length >>> 1;
    if (history.length) {
      const total = history.length % 2 ? history[mid] : (history[mid - 1] + history[mid]) / 2;
      capacity = { total, samples: history.length, windows: history.length, confidence: "low", method: "legacy" };
    }
  }
  return {
    at: query.at, elapsed: query.elapsed, pct: query.pct,
    tokens: Number.isFinite(result.tokens) ? result.tokens : null,
    capacity,
    coverageKey: result.coverageKey ?? null,
    coverageComplete: result.coverageComplete !== false && !(result.failedSources > 0),
    sourceCount: result.sourceCount || 1,
    externalActivity: Boolean(result.externalActivity),
    reason: result.reason || "",
  };
}

export function quotaEstimateView(estimates, account, w, id) {
  const query = quotaEstimateRequest(account, w, id);
  if (!query) return null;
  const entry = estimates[query.storeKey];
  if (!entry) return { pending: true };
  const matching = entry.at === query.at && entry.elapsed === query.elapsed && entry.pct === query.pct;
  return {
    ...entry,
    pending: !matching,
    tokens: matching ? entry.tokens : null,
    reason: matching ? entry.reason : "",
    externalActivity: matching && entry.externalActivity,
    estimatedUsed: entry.capacity ? entry.capacity.total * query.pct / 100 : null,
  };
}
