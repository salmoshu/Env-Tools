// 全量窗口默认页：会话用量分析（多 agent）+ 套餐配额总览。
// 数据两条线：analytics 走 get-analytics（Rust 原生引擎），
// 配额走 usage-update 广播（60s 定时 + did-finish-load 补推）。
// v0.7.1：配额跟随 agent 筛选、目标默认"全部来源"、token 趋势折线图、i18n。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_COLORS, AGENT_LABELS, abbrev, abbrev2, fmtTokens, activateOnKeys, fmt, fmtPct, fmtReset, fmtSpan, fmtTimestamp,
  isNewerVersion, levelClass, sortByDisplayOrder, timeFractionOf,
} from "../utils.js";
import {
  CalendarHeatmap, GroupedBars, DonutChart, LineChart, MODEL_PALETTE,
  SERIES_DEFS, StackedBars, ProjectBars,
} from "../components/charts.jsx";
import { RefreshIcon } from "../components/Titlebar.jsx";
import Select from "../components/Select.jsx";
import ResetChances from "../components/ResetChances.jsx";
import BrandIcon from "../components/BrandIcon.jsx";
import UpgradeOverlay from "../components/UpgradeOverlay.jsx";
import AgentAccountControl from "../components/AgentAccountControl.jsx";
import KimiWebAuth from "../components/KimiWebAuth.jsx";
import { agentAccountId } from "../components/AgentAccountPicker.jsx";
import { agentProviderKey, useAgentAccountStates } from "../agentAccounts.js";
import { t, useLang } from "../i18n.js";
import { useInstallState, setInstallResult, upgradingTargets as getUpgradingTargets } from "../installState.js";

const ANALYTICS_REFRESH_MS = 5 * 60 * 1000;
// 页面分析口径固定 30 天（v0.7.34 移除范围下拉框后，历史 localStorage 里的
// "7"/"90" 不再生效——否则按天视图只剩 7 桶、命中率图因点数不足无法缩放）
const ANALYTICS_DAYS = "30";
// 首屏秒开：按 目标|agent|范围 缓存最近一次分析载荷，启动先画旧数据，
// 新鲜数据到达后无缝替换（meta 行的"更新于"时间戳自然暴露陈旧度）

// 组合缓存只存内存：此前每次刷新都把最多 8 份大 JSON 从 localStorage
// 读出再整体写回（同步主线程 IO，单次数 MB），是周期性卡顿的主要来源。
// 内存 Map 同样避免切组合白屏，只是不再跨重启保留。
const analyticsMemoryCache = new Map();
function readAnalyticsCache() {
  return Object.fromEntries(analyticsMemoryCache);
}

function writeAnalyticsCache(combo, payload) {
  analyticsMemoryCache.set(combo, payload);
  const keys = [...analyticsMemoryCache.keys()];
  while (keys.length > 8) analyticsMemoryCache.delete(keys.shift());
}
const AGENT_KEY = "ai-usage-monitor.analytics-agent";
const TARGET_KEY = "ai-usage-monitor.target";
const TREND_KEY = "ai-usage-monitor.trend-granularity";
// 长窗口粒度的拉取天数：按周=90 天（约 13 周）、按月=365 天（约 12 个月）；
// 按小时/按天用主视图 30 天口径（按天恰为一个月，按小时为今日 24 小时）
const TREND_EXT_DAYS = { week: 90, month: 365 };
// 会话明细：分组 / 排序偏好持久化；可排序的数值列（表头点击切换升降序）
const SESSIONS_SORT_KEY = "ai-usage-monitor.sessions-sort";
const SESSIONS_GROUP_KEY = "ai-usage-monitor.sessions-group";
const SESSION_SORTABLE = ["total", "requests", "last", "rate"];
// 会话行"结束于 X 前"阈值：更近的视为仍在进行
const SESSION_LIVE_THRESHOLD_SEC = 300;
// 速率卡全屏（近 1 天活跃）视图的项目折叠偏好：项目名集合，跨会话持久
const RATE_COLLAPSED_KEY = "ai-usage-monitor.rate-collapsed";
// 分析区块的默认顺序与拖拽重排持久化键（v0.7.32）
// v0.7.34：trend 并入 daily 卡（粒度选择器切换 日=堆叠柱 / 周/年=折线），
// 存储顺序里的旧 "trend" id 因不在默认列表而被自动剔除
const CARD_ORDER_KEY = "ai-usage-monitor.card-order";
const CARD_DEFAULT_ORDER = ["daily", "yearly", "share", "dailyModel", "cacheRate", "topProjects", "sessions"];
const SESSION_GROUP_OPTIONS = ["none", "project", "agent"];
const SESSION_ROW_CAP = 200;
// 默认只渲染前 100 行（可一键展开全部）：长表是分析页滚动/渲染的主要开销
const SESSION_ROW_DEFAULT = 100;
// 设置页"显示"面板的 provider 勾选（与悬浮看板共用同一 localStorage 键）
const DISPLAY_SELECTION_KEY = "ai-usage-monitor.display-providers";

function readDisplaySelection() {
  try {
    const stored = JSON.parse(localStorage.getItem(DISPLAY_SELECTION_KEY) || "null");
    if (Array.isArray(stored)) return new Set(stored.filter((p) => typeof p === "string"));
  } catch {}
  return null;
}

const AGENT_PROVIDERS = {
  kimi: ["Kimi Code"],
  "kimi-work": ["Kimi Code"],
  codex: ["OpenAI Codex"],
  glm: ["GLM"],
  deepseek: ["DeepSeek"],
  // ZCode 走智谱 GLM Coding Plan，筛选 zcode 时配额区显示 GLM 卡
  zcode: ["GLM"],
};
// GLM / DeepSeek are model vendors selected inside an agent session, so they
// stay available in analytics labels but are not agent filter choices.
const AGENT_FILTER_OPTIONS = Object.entries(AGENT_LABELS)
  .filter(([value]) => value !== "glm" && value !== "deepseek");
const AGENT_FILTER_VALUES = new Set(AGENT_FILTER_OPTIONS.map(([value]) => value));

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDateLabel(date) {
  return date.slice(5);
}

function MembershipLine({ account }) {
  const membership = account.membership;
  if (!membership || membership.error || !membership.ends_at) return null;
  if (membership.error) {
    return <div className="qmembership error">{membership.error}</div>;
  }
  const autoRenew = Boolean(membership.auto_renew);
  const endMs = new Date(membership.ends_at).getTime();
  if (!Number.isFinite(endMs)) return null;
  const leftSeconds = Math.floor((endMs - Date.now()) / 1000);
  const ended = leftSeconds < 0;
  const span = fmtSpan(Math.abs(leftSeconds));
  const pad = (n) => String(n).padStart(2, "0");
  const endDate = new Date(endMs);
  const endText = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())} ` +
    `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
  const left = ended ? `ended ${span} ago` : `${autoRenew ? "renews" : "ends"} in ${span}`;
  return (
    <div className="qmembership">
      <span>{autoRenew ? "Renews" : "Ends"}</span>
      <strong>{endText}</strong>
      <em className={ended ? "ended" : ""}>{left}</em>
    </div>
  );
}

/** 套餐配额 token 额度估算（v0.7.53）：厂商只公布已用百分比（Kimi/Codex）
 *  或积分（GLM），窗口 token 总额需反推：
 *  估算总额 = 窗口 elapsed 时段内实际 token 用量 ÷ 窗口已用%
 *  （用量来自分析引擎，omp 会话按底层模型归并计入对应配额）。
 *  区块标题旁的开关切换显示口径：百分比（原样）/ token 额度（已用/≈总） */
const QUOTA_PROVIDER_KEYS = {
  "Kimi Code": "kimi",
  "OpenAI Codex": "codex",
  GLM: "glm",
};
const QUOTA_TOKEN_MODE_KEY = "ai-usage-monitor.quota-token-mode";
// 估算范围含 5h/7d 与月度（≤32d，Kimi Monthly Total 也支持 token 显示）
const QUOTA_ESTIMABLE_MAX_SECONDS = 32 * 86400;
// 拉取桶 30 分钟：倒计时推进不再逐秒/逐5分钟重拉；查询侧带 ±2 桶容差，
// 桶翻转期间沿用最近一次结果——修复估算时隐时现的闪烁
const QUOTA_EST_FETCH_BUCKET = 1800;

/** 窗口估算元数据：{ key, bucket(30 分钟桶), elapsed }；不满足估算条件返回 null */
function quotaEstimateMeta(provider, w) {
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

/** 容差查询：精确桶 → ±1、±2 桶，命中即返回最近拉取结果 */
function quotaEstimateLookup(estimates, provider, w) {
  const meta = quotaEstimateMeta(provider, w);
  if (!meta) return null;
  for (const offset of [0, -1, 1, -2, 2]) {
    const v = estimates[`${meta.key}|${meta.bucket + offset * QUOTA_EST_FETCH_BUCKET}`];
    if (v != null) return v.tokens;
  }
  return null;
}

/// 查询估算总额（含历史中位）：返回 median(历史各代 + 当前单点) 或 null
function quotaEstimateLookupTotal(estimates, provider, w, usedTokens) {
  const meta = quotaEstimateMeta(provider, w);
  if (!meta) return null;
  for (const offset of [0, -1, 1, -2, 2]) {
    const v = estimates[`${meta.key}|${meta.bucket + offset * QUOTA_EST_FETCH_BUCKET}`];
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

/** 拉取各窗口 elapsed 时段的实际 token 用量（随配额 60s 刷新自动更新；
 *  指纹按 5 分钟桶节流，避免倒计时秒级变化反复触发） */
function useQuotaEstimates(accounts, target) {
  const [estimates, setEstimates] = useState({});
  const fingerprint = accounts
    .flatMap((a) => (a.windows || [])
      .map((w) => {
        const meta = quotaEstimateMeta(a.provider, w);
        if (!meta) return null;
        const at = a.fetched_at ? Math.floor(new Date(a.fetched_at).getTime() / 1000) : 0;
        return `${meta.key}|${meta.bucket}|${meta.windowSeconds}|${at}`;
      })
      .filter(Boolean))
    .join("&");
  useEffect(() => {
    if (!fingerprint) return;
    let cancelled = false;
    const wants = new Map(); // 存储键 = key|bucket（与 quotaEstimateLookup 的查询键一致）
    for (const token of fingerprint.split("&")) {
      const [key, bucket, win, at] = token.split("|");
      const storeKey = `${key}|${bucket}`;
      wants.set(storeKey, { key, elapsed: Number(bucket), win: Number(win), at: Number(at) });
    }
    Promise.all(
      [...wants.entries()].map(async ([storeKey, { key, elapsed, win, at }]) => {
        try {
          const result = await window.api.getAnalyticsRolling(key, elapsed, target, {
            at, window: win, history: true,
          });
          if (!cancelled && result && result.ok) {
            return [storeKey, { tokens: result.tokens || 0, history: result.history || null }];
          }
        } catch {}
        return null;
      }),
    ).then((rows) => {
      if (cancelled) return;
      setEstimates((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          if (row) next[row[0]] = row[1];
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [fingerprint, target]);
  return estimates;
}

/// 估算总额：median(各代历史高水位估算 + 当前单点)——比单点更稳，
/// 百分比取整/跨设备覆盖差被多代平滑。无历史时退化为单点。
function quotaEstimateTotal(estimates, storeKey, usedTokens, pct) {
  const entry = estimates[storeKey];
  if (!entry) return usedTokens / (pct / 100);
  const points = [usedTokens / (pct / 100)];
  const hist = entry.history;
  if (Array.isArray(hist) && hist.length > 0) {
    points.push(...hist.filter((v) => Number.isFinite(v) && v > 0));
  }
  points.sort((a, b) => a - b);
  const mid = Math.floor(points.length / 2);
  return points.length % 2 ? points[mid] : (points[mid - 1] + points[mid]) / 2;
}

/** 周窗口 token 统计卡（单厂商）：近 ~13 周的 7d 窗口用量（周柱）与
 *  5h 峰值窗口用量并排，另以虚线参考线标出按当前配额反推的 5h 额度估算——
 *  直接回答"该厂商的 5h 额度预计多大、我平时压到多满"。
 *  数据独立自取 90 天（不随页面范围/agent 筛选），后端 weekly_quota
 *  厂商口径（omp 底层模型已归并）；下拉切换 Kimi/Codex/GLM（无"全部"） */
const QUOTA_WEEKLY_PROVIDER_KEY = "ai-usage-monitor.quota-weekly-provider";

function QuotaWeeklyCard({ target, weekStart, accounts, estimates }) {
  const [weeklyAnalytics, setWeeklyAnalytics] = useState(null);
  const [provider, setProvider] = useState(() => {
    try {
      const saved = localStorage.getItem(QUOTA_WEEKLY_PROVIDER_KEY);
      return ["kimi", "codex", "glm"].includes(saved) ? saved : "kimi";
    } catch { return "kimi"; }
  });
  useEffect(() => {
    let cancelled = false;
    window.api.getAnalytics(90, "all", target)
      .then((result) => { if (!cancelled && result && result.ok) setWeeklyAnalytics(result.analytics); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [target]);
  const weeks = useMemo(() => {
    const weekly = weeklyAnalytics && weeklyAnalytics.weekly_quota;
    if (!Array.isArray(weekly)) return [];
    return weekly
      .map((row) => ({
        start: row.start,
        end: row.end,
        total: (row.providers && row.providers[provider] && row.providers[provider].total) || 0,
        peak5h: (row.providers && row.providers[provider] && row.providers[provider].peak5h) || 0,
      }))
      .filter((row) => row.total > 0 || row.peak5h > 0);
  }, [weeklyAnalytics, provider]);
  // 5h 额度估算参考线：该厂商当前 5h 窗口的 已用token ÷ 已用%。
  // 多账号（如 codex free/plus）时遍历所有账号找有用量的 5h 窗口
  const limit5h = useMemo(() => {
    const providerName = { kimi: "Kimi Code", codex: "OpenAI Codex", glm: "GLM" }[provider];
    const candidates = accounts
      .filter((a) => a.provider === providerName)
      .flatMap((a) => a.windows || [])
      .filter((w) => w.window_seconds && Math.abs(w.window_seconds - 18000) <= 600
        && w.used_percent > 0);
    for (const w5h of candidates) {
      const used = quotaEstimateLookup(estimates, providerName, w5h);
      if (used != null) {
        const total = quotaEstimateLookupTotal(estimates, providerName, w5h, used);
        if (total != null) return total;
      }
    }
    return null;
  }, [accounts, estimates, provider]);
  if (weeks.length === 0) return null;
  const WINDOWS_PER_WEEK = 168 / 5; // 33.6 个 5h 窗口
  const mmdd = (date) => date.slice(5);
  return (
    <section className="card quota-weeks">
      <div className="card-head-row">
        <h2>{t("dash.quotaWeekly")}</h2>
        <div className="card-head-actions">
          <Select
            value={provider}
            ariaLabel={t("dash.quotaWeeklyProvider")}
            align="right"
            onChange={(value) => {
              setProvider(value);
              try { localStorage.setItem(QUOTA_WEEKLY_PROVIDER_KEY, value); } catch {}
            }}
            options={[["kimi", "Kimi"], ["codex", "Codex"], ["glm", "GLM"]]}
          />
        </div>
      </div>
      <div className="table-hint" style={{ marginBottom: 6 }}>{t("dash.quotaWeeklyHint")}</div>
      <div className="legend">
        <span className="item"><span className="swatch" style={{ background: "var(--c-input)" }} />{t("dash.quotaWeekly7d")}</span>
        <span className="item"><span className="swatch" style={{ background: "var(--c-output)" }} />{t("dash.quotaWeekly5h")}</span>
      </div>
      {weeks.length < 2 ? <div className="table-hint">{t("dash.quotaWeeklyShort")}</div> : null}
      <GroupedBars
        className="tall"
        zoomable
        labels={weeks.map((w) => mmdd(w.start))}
        series={[
          { color: "var(--c-input)", data: weeks.map((w) => w.total) },
          { color: "var(--c-output)", data: weeks.map((w) => w.peak5h) },
        ]}
        refLine={limit5h ? { value: limit5h, label: `${t("dash.quotaWeekly5hLimit")} ≈${fmtTokens(limit5h)}` } : null}
        columnTip={(i) => {
          const w = weeks[i] || {};
          const range = `${mmdd(w.start || "")}–${mmdd(w.end || "")}`;
          const current = i === weeks.length - 1 ? ` · ${t("dash.quotaWeekCurrent")}` : "";
          return `<b>${range}${current}</b>` +
            `<div class="tt-row"><span class="swatch" style="background:var(--c-input)"></span>${t("dash.quotaWeekly7d")}<span class="tt-val">${fmtTokens(w.total || 0)}</span></div>` +
            `<div class="tt-row"><span class="swatch" style="background:var(--c-output)"></span>${t("dash.quotaWeekly5h")}<span class="tt-val">${fmtTokens(w.peak5h || 0)}</span></div>` +
            (limit5h
              ? `<div class="tt-row">${t("dash.quotaWeekly5hLimit")}<span class="tt-val">≈${fmtTokens(limit5h)}</span></div>`
              : "");
        }}
      />
    </section>
  );
}

function QuotaCard({ account, versions, onUpgrade, upgrading, providerKey, accountState, tokenMode, estimates, onRefresh }) {
  const updated = account.fetched_at
    ? new Date(account.fetched_at).toLocaleTimeString("en-GB", { hour12: false })
    : "";
  const info = versions[account.provider] || {};
  const newer = info.current && info.latest && isNewerVersion(info.latest, info.current);
  // GLM 双通道：coding plan（bigmodel）窗口 + Start Plan（ZCode）窗口，
  // "Start ·" 前缀区分；两路并存时显示通道切换下拉。边界：
  // - 仅 StartPlan 有数据（如 API key 配额不可用）→ 单通道直接显示它
  // - StartPlan 无额度/数据 → 不出现下拉，回落 BigModel（空额度即空显示）
  const allWindows = account.windows || [];
  const isGlm = account.provider === "GLM";
  const bigmodelWindows = allWindows.filter((w) => !String(w.label || "").startsWith("Start"));
  const startWindows = allWindows.filter((w) => String(w.label || "").startsWith("Start"));
  const dualChannel = isGlm && bigmodelWindows.length > 0 && startWindows.length > 0;
  const singleStart = isGlm && bigmodelWindows.length === 0 && startWindows.length > 0;
  const [channel, setChannel] = useState(() => {
    try { return localStorage.getItem("glm-quota-channel") || "bigmodel"; } catch { return "bigmodel"; }
  });
  const activeChannel = dualChannel
    ? channel
    : singleStart ? "start" : "bigmodel";
  const shownWindows = activeChannel === "start" ? startWindows : bigmodelWindows;
  const startPlanName = (account.extra_lines || [])
    .find((l) => String(l).startsWith("Start plan:"))?.slice("Start plan: ".length);
  const stats = Array.isArray(account.stats) && account.stats.length > 0 ? account.stats : null;
  const [webAuthOpen, setWebAuthOpen] = useState(false);
  // Kimi 会员等级/月额度依赖 kimi.com 网页会话：缺失或过期时直接在卡片内
  // 引导重新授权，而不是只留一个 plan=unknown。
  const webSession = account.web_session;
  const webState = webSession && webSession.state;
  const showWebNotice = account.provider === "Kimi Code" && webState && webState !== "ok";
  const webAuthIssue = webState === "expired" || webState === "missing";
  const webMessage = webAuthIssue
    ? t(webState === "missing" ? "dash.kimiWebMissing" : "dash.kimiWebExpired")
    : t(webState === "degraded" ? "dash.kimiWebDegraded" : "dash.kimiWebError");
  return (
    <>
    <div className="qcard" data-provider-key={providerKey || undefined}>
      <div className="qcard-head">
        <BrandIcon of={account.provider} size={16} />
        <span className="qname">{account.provider}</span>
        {newer && onUpgrade ? (
          <span
            className="qver upgrade"
            role="button"
            tabIndex={0}
            title={t("upgrade.click")}
            onClick={() => onUpgrade(account.provider)}
            onKeyDown={activateOnKeys(() => onUpgrade(account.provider))}
          >
            v{info.current} <span className="new">→ {info.latest}</span>
          </span>
        ) : newer ? (
          <span className="qver">v{info.current} <span className="new">→ {info.latest}</span></span>
        ) : info.current ? (
          <span className="qver">v{info.current}</span>
        ) : null}
        <AgentAccountControl provider={providerKey} state={accountState} />
        <span className="plan">{activeChannel === "start"
          ? (startPlanName || "Start Plan")
          : (account.plan || "unknown")}</span>
        {account.available === false ? (
          <span className="stale-tag" title={t("dash.dsUnavailableHint")}>{t("dash.dsUnavailable")}</span>
        ) : null}
        {dualChannel ? (
          <Select
            className="plan-switch"
            value={channel}
            ariaLabel="Plan channel"
            onChange={(value) => {
              setChannel(value);
              try { localStorage.setItem("glm-quota-channel", value); } catch {}
            }}
            options={[
              ["bigmodel", "BigModel"],
              ["start", "StartPlan"],
            ]}
          />
        ) : null}
        {upgrading && Array.isArray(upgrading.targets) && upgrading.targets.includes(account.provider) ? (
          <span className="upgrading-badge"><span className="spin-dot" />{t("upgrade.runningBadge")}</span>
        ) : null}
        {account.stale ? (
          <span className="stale-tag" title={t("dash.quotaStaleHint")}>{t("dash.quotaStale")}</span>
        ) : null}
        <span className="qupdated">{updated}</span>
      </div>
      {showWebNotice ? (
        <div className={`kimi-web-notice ${webAuthIssue ? "auth" : "warn"}`} title={webSession.message || ""}>
          <span className="kimi-web-notice-text">{webMessage}</span>
          {webAuthIssue ? (
            <button type="button" className="kimi-web-btn" onClick={() => setWebAuthOpen(true)}>
              {t("dash.kimiWebReauth")}
            </button>
          ) : (
            <button type="button" className="kimi-web-btn" onClick={() => onRefresh && onRefresh()}>
              {t("state.retry")}
            </button>
          )}
        </div>
      ) : null}
      <MembershipLine account={account} />
      {stats ? (
        <div className="qstats">
          {stats.map((s, index) => (
            <div className="qstat" key={`stat-${index}`}>
              <span className="qstat-label">{s.label}</span>
              <span className="qstat-value">{s.value}</span>
              {s.sub ? <span className="qstat-sub">{s.sub}</span> : null}
            </div>
          ))}
        </div>
      ) : (!isGlm ? (account.extra_lines || []).map((line, index) => (
        <div className="qextra" key={`extra-${index}`}>{line}</div>
      )) : null)}
      {shownWindows.map((w, index) => {
        const pct = w.used_percent == null ? 0 : Math.max(0, Math.min(100, w.used_percent));
        const fraction = timeFractionOf(w);
        const reset = fmtReset(w.reset_after_seconds);
        const showUsage = w.usage && (!isGlm || String(w.label || "").startsWith("Start"));
        const tail = reset
          ? <span className="reset">{reset}</span>
          : (showUsage
            ? <span className="reset">Usage {w.usage}</span>
            : null);
        // token 额度口径：百分比替换为 已用/≈总（无估算数据的窗口回退百分比显示）
        let pctText = `${pct.toFixed(1)}%`;
        let pctTitle = undefined;
        if (tokenMode === "tokens") {
          const meta = quotaEstimateMeta(account.provider, w);
          const usedTokens = quotaEstimateLookup(estimates, account.provider, w);
          if (usedTokens != null) {
            // Kimi 月度为家庭共享额度（w.sub 带 "Kimi Code share: xx.xx%"）：
            // 本地只覆盖 Kimi Code 份额，按 share 校正有效已用比例再反推总额
            let effectivePct = pct;
            const shareMatch = String(w.sub || "").match(/([\d.]+)\s*%/);
            const share = shareMatch ? Number(shareMatch[1]) : null;
            if (share && share > 0 && share < 100) effectivePct = pct * share / 100;
            const meta = quotaEstimateMeta(account.provider, w);
            const storeKey = meta ? `${meta.key}|${meta.bucket}` : null;
            const totalTokens = quotaEstimateLookupTotal(estimates, account.provider, w, usedTokens)
              ?? (usedTokens / (effectivePct / 100));
            pctText = `${abbrev2(usedTokens)} / ≈${abbrev2(totalTokens)}`;
            pctTitle = (share && share > 0 && share < 100)
              ? t("dash.quotaEstimateTipShared")
                .replace("{used}", abbrev2(usedTokens))
                .replace("{pct}", effectivePct.toFixed(2))
                .replace("{share}", share.toFixed(2))
              : t("dash.quotaEstimateTip")
                .replace("{used}", abbrev2(usedTokens))
                .replace("{pct}", pct.toFixed(0));
          } else if (meta) {
            pctTitle = t("dash.quotaEstimatePending");
          }
        }
        return (
          <div className="qquota" key={index}>
            <div className="qrow">
              <span>{String(w.label || "").replace(/^Start · /, "")}</span>
              <span className="pct" title={pctTitle}>{pctText}{tail ? " · " : ""}{tail}</span>
            </div>
            <div className="bar">
              <div className={`fill ${levelClass(pct)}`} style={{ width: `${pct}%` }} />
              {fraction != null
                ? <div className="marker" style={{ left: `${(fraction * 100).toFixed(1)}%` }} />
                : null}
            </div>
            {w.sub ? <div className="qwin-sub">{w.sub}</div> : null}
          </div>
        );
      })}
      {(() => {
        // StartPlan 通道显示套餐到期，BigModel 重置机会仍可从独立 hint 查看。
        if (isGlm && activeChannel === "start") {
          const endsIn = Math.max(
            0,
            ...startWindows.map((w) => Number(w.reset_after_seconds) || 0),
          );
          if (!endsIn) return null;
          return (
            <div className="limit-resets">
              {t("dash.startPlanEnds").replace("{d}", fmtSpan(endsIn))}
            </div>
          );
        }
        return null;
      })()}
      <ResetChances account={account} />
    </div>
    {webAuthOpen ? (
      <KimiWebAuth
        account={account}
        onClose={() => setWebAuthOpen(false)}
        onSaved={() => onRefresh && onRefresh()}
      />
    ) : null}
    </>
  );
}

/** 配额异常占位卡片：按 provider 类型分级引导，API 型绝不引导"去登录" */
function QuotaErrorCard({ err, onFix, providerKey, accountState, refreshing = false }) {
  const [expanded, setExpanded] = useState(false);
  // 与页头共用实际刷新周期，直到刷新完成信号或刷新看门狗结束。
  const retry = () => {
    if (!refreshing && onFix) onFix("refresh");
  };
  const message = String((err && err.error) || t("state.unknownError"));
  const provider = String((err && err.provider) || "");
  const accountLabel = err && err.account_label ? ` · ${err.account_label}` : "";
  const lower = message.toLowerCase();
  const isApiProvider = provider === "DeepSeek" || provider === "GLM";
  // 网络类错误优先归类：断网/代理不可达时不能误导用户去登录或加 key
  const isNetwork =
    /network request failed|failed to fetch|networkerror|cannot reach|timed?\s*out|dns|econn|enotfound|erefused|unreachable|socket hangup|offline|connection (refused|reset|failed)|proxy/i.test(message);
  const kind = isNetwork
    ? "network"
    : isApiProvider
      ? "keys"
      : /login|expired|unauthorized|401|credential|oauth|token/i.test(message)
        ? "login"
        : /api.?key|not set|configure|balance/i.test(lower)
          ? "keys"
          : "retry";
  const hints = { login: t("err.loginHint"), keys: t("err.keysHint"), retry: t("err.retryHint"), network: t("err.networkHint") };
  const loginFeedback = err && err.login_feedback;
  return (
    <div
      className="qcard qcard-error"
      data-provider-key={providerKey || agentProviderKey(provider) || undefined}
      data-account-id={(err && err.account_id) || "default"}
    >
      <div className="qcard-head">
        <BrandIcon of={provider} size={16} />
        <span className="qname">{provider}{accountState && accountState.accounts.length > 1 ? "" : accountLabel}</span>
        <AgentAccountControl provider={providerKey} state={accountState} />
        <span className="plan">{t("dash.unavailable")}</span>
      </div>
      <div className="qerror-hint">{hints[kind]}</div>
      <MembershipLine account={err} />
      <button className="qerror-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? t("state.hideDetails") : t("state.details")}
      </button>
      {expanded && <div className="qerror-detail">{message}</div>}
      <div className="qerror-actions">
        {kind === "login" && (
          <button className="qerror-btn" onClick={() => onFix && onFix("login")}>{t("err.goLogin")}</button>
        )}
        {kind === "keys" && (
          <button className="qerror-btn" onClick={() => onFix && onFix("settings")}>{t("err.addKey")}</button>
        )}
        <button className="qerror-btn ghost" disabled={refreshing} aria-busy={refreshing} onClick={retry}>
          <RefreshIcon spinning={refreshing} /> {t(refreshing ? "state.retrying" : "state.retry")}
        </button>
      </div>
      {loginFeedback ? <div className={`qerror-login-feedback${loginFeedback.ok ? " ok" : ""}`}>{loginFeedback.text}</div> : null}
    </div>
  );
}

function targetLabel(item) {
  if (!item) return "";
  if (item.kind === "aggregate") return t("dash.targetMerged");
  if (item.kind === "local") {
    return `${item.os || item.label || "local"} (${t("dash.targetCurrent")})`;
  }
  if (item.kind === "wsl") return `${t("dash.targetWsl")} · ${item.distro}`;
  if (item.kind === "ssh") return `${t("dash.targetSsh")} · ${item.host}`;
  return item.label;
}

/** 按 agent 筛选配额：选 kimi 时配额区只显示 Kimi */
function filterByAgent(list, agent) {
  const allowed = AGENT_PROVIDERS[agent];
  if (!allowed) return list;
  return list.filter((item) => allowed.includes(item.provider));
}

export default function Dashboard({ lastPayload, refreshing, onRefresh }) {
  const [analytics, setAnalytics] = useState(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [days] = useState(ANALYTICS_DAYS);
  const [agent, setAgent] = useState(() => {
    try {
      const saved = localStorage.getItem(AGENT_KEY) || "all";
      return AGENT_FILTER_VALUES.has(saved) ? saved : "all";
    } catch { return "all"; }
  });
  const [targets, setTargets] = useState([
    { id: "aggregate", kind: "aggregate" },
    { id: "local", kind: "local", label: "local" },
  ]);
  const [target, setTarget] = useState(() => {
    try { return localStorage.getItem(TARGET_KEY) || "aggregate"; } catch { return "aggregate"; }
  });
  const [usage, setUsage] = useState(null);
  const [sessionsSort, setSessionsSort] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSIONS_SORT_KEY) || "null");
      if (saved && SESSION_SORTABLE.includes(saved.key) && (saved.dir === 1 || saved.dir === -1)) {
        return saved;
      }
    } catch {}
    return { key: "total", dir: -1 };
  });
  const [sessionsGroup, setSessionsGroup] = useState(() => {
    try {
      const saved = localStorage.getItem(SESSIONS_GROUP_KEY);
      return SESSION_GROUP_OPTIONS.includes(saved) ? saved : "none";
    } catch { return "none"; }
  });
  // 速率卡全屏视图：折叠的项目名集合（会话多的项目收起省空间）
  const [rateCollapsed, setRateCollapsed] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RATE_COLLAPSED_KEY) || "[]");
      return new Set(Array.isArray(stored) ? stored.filter((n) => typeof n === "string") : []);
    } catch { return new Set(); }
  });
  const toggleRateProject = (name) => {
    setRateCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try { localStorage.setItem(RATE_COLLAPSED_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  // 分析区块拖拽重排（v0.7.32）：8 个卡片在 flex-wrap 容器里按 CSS order
  // 排布，拖拽手柄按下时才开启 draggable；顺序持久化 localStorage
  const [cardOrder, setCardOrder] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(CARD_ORDER_KEY) || "null");
      if (Array.isArray(stored)) {
        const next = stored.filter((id) => CARD_DEFAULT_ORDER.includes(id));
        for (const id of CARD_DEFAULT_ORDER) if (!next.includes(id)) next.push(id);
        return next;
      }
    } catch {}
    return CARD_DEFAULT_ORDER;
  });
  const [dragCard, setDragCard] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  useEffect(() => {
    // 原生拖拽期间不派发 mouseup；手柄按下未拖动即松开时在此复位
    const clear = () => setDragCard(null);
    window.addEventListener("mouseup", clear);
    return () => window.removeEventListener("mouseup", clear);
  }, []);
  const dragStart = (event, id) => {
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  };
  const dragEnd = () => { setDragCard(null); setDropTarget(null); };
  const dropCard = (targetId) => {
    const source = dragCard;
    setDropTarget(null);
    setDragCard(null);
    if (!source || source === targetId) return;
    setCardOrder((prev) => {
      const next = prev.filter((id) => id !== source);
      const at = next.indexOf(targetId);
      next.splice(at >= 0 ? at : next.length, 0, source);
      try { localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const dragHandle = (id) => (
    <span
      className="card-drag"
      title={t("dash.reorderHint")}
      onMouseDown={() => setDragCard(id)}
    >⠿</span>
  );
  const cardMods = (id) => ({
    style: { order: cardOrder.indexOf(id) },
    draggable: dragCard === id,
    onDragStart: (event) => dragStart(event, id),
    onDragEnd: dragEnd,
    onDragOver: (event) => {
      event.preventDefault();
      setDropTarget((prev) => (prev === id ? prev : id));
    },
    onDrop: () => dropCard(id),
  });
  const [trendGran, setTrendGran] = useState(() => {
    try {
      const saved = localStorage.getItem(TREND_KEY);
      return ["hourly", "day", "week", "month"].includes(saved) ? saved : "day";
    } catch { return "day"; }
  });
  // 按月/按年需要更长数据窗口：单独拉取，避免影响主视图的 30 天口径
  const [trendExt, setTrendExt] = useState(null);
  // 周起点与速度口径（设置页）：趋势分桶边界与 Speed 列/速率卡的计算方式
  const [weekStart, setWeekStart] = useState("monday");
  const [speedMode, setSpeedMode] = useState("gen");
  const [upgradeProvider, setUpgradeProvider] = useState(null);
  const [loginFeedback, setLoginFeedback] = useState({});
  // 铺满视图的卡片 id（每日 Token 及以下各区块）；Esc 退出
  const [expandedCard, setExpandedCard] = useState(null);
  useEffect(() => {
    if (!expandedCard) return;
    const onKey = (event) => { if (event.key === "Escape") setExpandedCard(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedCard]);
  const cardCls = (id, base = "card") => `${base}${expandedCard === id ? " card-expanded" : ""}`;
  const expandBtn = (id) => (
    <span className="card-head-actions">
      {/* 全屏（铺满）时卡片内部也提供刷新入口：滚远后不必回页头找按钮 */}
      {expandedCard === id ? (
        <button
          type="button"
          className="refresh-inline"
          title={`${t("tip.refresh")} (F5)`}
          aria-keyshortcuts="F5"
          disabled={refreshing}
          onClick={() => onRefresh && onRefresh()}
        >
          <RefreshIcon spinning={refreshing} /> {t("tip.refresh")}
        </button>
      ) : null}
      <button
        type="button"
        className="refresh-inline card-expand-btn"
        title={expandedCard === id ? t("dash.collapseView") : t("dash.expandView")}
        onClick={() => setExpandedCard(expandedCard === id ? null : id)}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          {expandedCard === id
            ? (<><path d="M11 7H7v4" /><path d="M11 11 7 7" /><path d="M1 5h4v4" /><path d="M1 1l4 4" /></>)
            : (<><path d="M7 1h4v4" /><path d="M11 1 7 5" /><path d="M5 11H1V7" /><path d="M1 11l4-4" /></>)}
        </svg>
      </button>
    </span>
  );

  useEffect(() => {
    window.api.getSettings().then((result) => {
      if (result && result.ok) {
        if (result.week_start) setWeekStart(result.week_start);
        if (result.speed_mode) setSpeedMode(result.speed_mode);
      }
    }).catch(() => {});
  }, []);
  // 升级状态来自全局 installState：切页后"升级中…"徽章与结果提示都还在
  const install = useInstallState();
  const analyticsBusy = useRef(false);
  // 手动刷新广播 analytics-invalidated 时若在途请求未完结，置位排队补拉
  const analyticsQueued = useRef(false);
  // 当前展示的 目标|agent|范围 组合：切换时先画该组合的磁盘缓存载荷
  const analyticsCombo = useRef("");
  const analyticsHash = useRef("");
  const [lang] = useLang();

  // 配额按目标路由：本地/汇总目标吃 60s 广播（lastPayload），远端目标走 get-usage
  const refreshUsage = useCallback(async (nextTarget) => {
    if (nextTarget === "local" || nextTarget === "aggregate") return;
    try {
      const result = await window.api.getUsage(nextTarget);
      if (result && (result.data || result.error)) setUsage(result);
    } catch {}
  }, []);

  useEffect(() => {
    if (target !== "local" && target !== "aggregate") refreshUsage(target);
  }, [target, refreshUsage]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (target !== "local" && target !== "aggregate") refreshUsage(target);
    }, 60000);
    return () => clearInterval(timer);
  }, [target, refreshUsage]);

  const requestAnalytics = useCallback(async (nextDays, nextAgent, nextTarget) => {
    const combo = `${nextTarget}|${nextAgent}|${nextDays}`;
    // 组合切换（含首次进入）时先画该组合的缓存载荷，冷扫描期间不白屏
    if (analyticsCombo.current !== combo) {
      analyticsCombo.current = combo;
      analyticsHash.current = "";
      const cached = readAnalyticsCache()[combo];
      if (cached) setAnalytics(cached);
    }
    if (analyticsBusy.current) return;
    analyticsBusy.current = true;
    //  spinner 延迟 200ms：快速返回的请求不产生额外整页渲染
    const busyTimer = setTimeout(() => setBusy(true), 200);
    try {
      const result = await window.api.getAnalytics(nextDays, nextAgent, nextTarget);
      if (result && result.ok && result.analytics) {
        // 内容没变就不 setAnalytics：定时刷新此前每分钟都强制整页重渲染。
        // 指纹由后端算好，避免在渲染进程对大 JSON 做序列化
        const fingerprint = result.analytics.content_hash || JSON.stringify(result.analytics);
        if (fingerprint !== analyticsHash.current) {
          analyticsHash.current = fingerprint;
          setAnalytics(result.analytics);
          writeAnalyticsCache(combo, result.analytics);
        }
        setAnalyticsError("");
      } else {
        setAnalyticsError((result && result.error) || t("dash.analyticsFailed"));
      }
    } catch (error) {
      setAnalyticsError(`Analytics failed: ${error.message || error}`);
    } finally {
      clearTimeout(busyTimer);
      analyticsBusy.current = false;
      setBusy(false);
      // 手动刷新（analytics-invalidated）撞在途请求时排队，完成后补拉新鲜数据
      if (analyticsQueued.current) {
        analyticsQueued.current = false;
        requestAnalytics(nextDays, nextAgent, nextTarget);
      }
    }
  }, []);

  useEffect(() => {
    window.api.listTargets().then((result) => {
      if (result && result.targets) {
        setTargets(result.targets);
        // 目标列表就绪后校验当前选择：不在列表（或旧的 local 默认）则回落到汇总
        const ids = new Set(result.targets.map((item) => item.id));
        setTarget((prev) => {
          if (ids.has(prev)) return prev;
          try { localStorage.setItem(TARGET_KEY, "aggregate"); } catch {}
          return "aggregate";
        });
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    requestAnalytics(days, agent, target);
    const timer = setInterval(() => requestAnalytics(days, agent, target), ANALYTICS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [days, agent, target, requestAnalytics]);

  // 手动刷新（页头/全屏卡/配额错误卡的重试按钮）会清空后端分析缓存并广播
  // analytics-invalidated：在此重拉，让图表与配额卡一起变新——此前没人订阅
  // 该广播，手动刷新只更新配额区，图表区看起来"没反应"
  useEffect(() => window.api.onAnalyticsInvalidated(() => {
    refreshUsage(target);
    if (analyticsBusy.current) {
      analyticsQueued.current = true;
      return;
    }
    requestAnalytics(days, agent, target);
  }), [days, agent, target, requestAnalytics, refreshUsage]);

  // 按月拉 365 天、按年拉 5 年；agent/target 切换后旧数据作废重拉
  useEffect(() => {
    const need = TREND_EXT_DAYS[trendGran];
    if (!need) return;
    if (trendExt && trendExt.days >= need && trendExt.agent === agent && trendExt.target === target) return;
    let cancelled = false;
    window.api.getAnalytics(need, agent, target).then((result) => {
      if (!cancelled && result && result.ok && result.analytics) {
        setTrendExt({ days: need, agent, target, analytics: result.analytics });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [trendGran, agent, target]);

  const usagePayload = target === "local" || target === "aggregate"
    ? lastPayload
    : (usage || { data: null });
  const data = usagePayload && usagePayload.data;
  // 多场升级并发时，仅当前平台/发行版的 provider 显示角标。
  const upgradingTargets = getUpgradingTargets(install, data);
  const upgrading = upgradingTargets.length ? { targets: upgradingTargets } : null;
  const errors = (data && data.errors) || [];
  const versions = (data && data.versions) || {};
  const allAccounts = (data && data.accounts) || [];
  const accountStates = useAgentAccountStates(allAccounts, target === "local" || target === "aggregate");
  const matchesActiveAccount = (item) => {
    const provider = agentProviderKey(item.provider);
    if (!provider) return true;
    const providerAccounts = allAccounts.filter((account) => account.provider === item.provider);
    const index = providerAccounts.indexOf(item);
    const id = item.account_id || (index >= 0 ? agentAccountId(item, index) : "default");
    if (accountStates[provider].defaultRemoved && id === "default") return false;
    return id === accountStates[provider].viewId;
  };
  // agent 筛选联动配额：只看 kimi 时配额区只显示 Kimi
  const agentAccounts = filterByAgent(allAccounts, agent);
  // Kimi 网页会话问题已在卡片内联引导，不再重复生成错误卡（兼容旧后端载荷）
  const agentErrors = filterByAgent(errors, agent)
    .filter((err) => !String((err && err.error) || "").includes("kimi_web_"));
  // 再叠加设置页"显示"勾选：未勾选的 provider（如 DeepSeek）配额区同样隐藏；
  // 与看板一致的自愈：勾选把现有 provider 全部过滤掉时回退为显示全部
  const displaySel = readDisplaySelection();
  let accounts = agentAccounts;
  let shownErrors = agentErrors;
  if (displaySel) {
    accounts = agentAccounts.filter((a) => displaySel.has(a.provider));
    shownErrors = agentErrors.filter((e) => !e.provider || displaySel.has(e.provider));
    if (accounts.length === 0 && shownErrors.length === 0
        && (agentAccounts.length > 0 || agentErrors.length > 0)) {
      accounts = agentAccounts;
      shownErrors = agentErrors;
    }
  }
  // 每家只显示当前账号；账号菜单仍合并完整注册表与 usage 选项。
  accounts = sortByDisplayOrder(accounts.filter(matchesActiveAccount), (a) => a.provider);
  shownErrors = sortByDisplayOrder(shownErrors.filter(matchesActiveAccount), (e) => e.provider || "");

  // 套餐配额显示口径：百分比（原样）/ token 额度估算（已用/≈总，开关持久化）
  const [quotaTokenMode, setQuotaTokenMode] = useState(() => {
    try { return localStorage.getItem(QUOTA_TOKEN_MODE_KEY) === "tokens" ? "tokens" : "pct"; } catch { return "pct"; }
  });
  const toggleQuotaTokenMode = () => {
    setQuotaTokenMode((prev) => {
      const next = prev === "tokens" ? "pct" : "tokens";
      try { localStorage.setItem(QUOTA_TOKEN_MODE_KEY, next); } catch {}
      return next;
    });
  };
  const quotaEstimates = useQuotaEstimates(accounts, target);

  // --- 分析数据派生 ---
  const dayList = (analytics && analytics.day_list) || [];
  const shortDays = dayList.map(shortDateLabel);
  const rank = (analytics && analytics.model_rank) || [];
  const models = (analytics && analytics.models) || [];
  const dailyModel = (analytics && analytics.daily_model) || {};
  const topModels = rank.slice(0, 8);
  const otherTotal = rank.slice(8).reduce((sum, item) => sum + item.total, 0);
  const pieItems = topModels.map((item, i) => ({
    name: item.model,
    value: item.total,
    color: MODEL_PALETTE[i % MODEL_PALETTE.length],
  }));
  if (otherTotal > 0) pieItems.push({ name: "other", value: otherTotal, color: "#8D9390" });

  const daily = analytics && analytics.daily;

  // --- 每日 Token（按小时/按天/按周/按月/按年分桶的构成堆叠柱） ---
  const trendNeed = TREND_EXT_DAYS[trendGran] || 0;
  const trendExtValid = trendExt && trendExt.days >= trendNeed
    && trendExt.agent === agent && trendExt.target === target;
  const trendSource = trendNeed ? (trendExtValid ? trendExt.analytics : null) : analytics;
  const trend = useMemo(() => {
    if (trendGran === "hourly") {
      const rows = (analytics && analytics.today_hourly) || [];
      return {
        labels: rows.map((entry) => String(entry.hour).padStart(2, "0")),
        series: SERIES_DEFS.map(([key, , color]) => ({ color, data: rows.map((entry) => entry[key]) })),
        tips: rows.map((entry, i) =>
          `<b>${String(i).padStart(2, "0")}:00 – ${String(i).padStart(2, "0")}:59</b>` +
          SERIES_DEFS.map(([key, name, color]) =>
            `<div class="tt-row"><span class="swatch" style="background:${color}"></span>${name}` +
            `<span class="tt-val">${fmtTokens(entry[key])}</span></div>`).join("") +
          `<div class="tt-row">${t("dash.ttTotal")}<span class="tt-val">${fmtTokens(entry.total)}</span></div>` +
          `<div class="tt-row">${t("dash.ttRequests")}<span class="tt-val">${fmt(entry.requests)}</span></div>`),
      };
    }
    const list = (trendSource && trendSource.day_list) || [];
    const rows = (trendSource && trendSource.daily) || [];
    const tip = (label, value) =>
      `<b>${label}</b><div class="tt-row">${t("dash.tokens")}<span class="tt-val">${fmtTokens(value || 0)}</span></div>`;
    if (trendGran === "day") {
      return {
        labels: list.map(shortDateLabel),
        series: SERIES_DEFS.map(([key, , color]) => ({ color, data: rows.map((e) => e[key]) })),
        values: rows.map((e) => e.total || 0),
        tips: list.map((day, i) => tip(shortDateLabel(day), rows[i]?.total)),
      };
    }
    const labels = [];
    const values = [];
    const tips = [];
    const seriesAgg = SERIES_DEFS.map(() => []);
    let acc = 0;
    let accKeys = SERIES_DEFS.map(() => 0);
    let bucketStartIdx = 0;
    const flush = (startIdx, endIdx) => {
      const label = trendGran === "week"
        ? list[startIdx].slice(5)
        : `${MONTH_SHORT[Number(list[startIdx].slice(5, 7)) - 1]} '${list[startIdx].slice(2, 4)}`;
      labels.push(label);
      values.push(acc);
      SERIES_DEFS.forEach((_, k) => seriesAgg[k].push(accKeys[k]));
      tips.push(tip(label, acc));
      acc = 0;
      accKeys = SERIES_DEFS.map(() => 0);
    };
    for (let i = 0; i < list.length; i++) {
      const day = new Date(`${list[i]}T00:00:00`);
      acc += rows[i]?.total || 0;
      SERIES_DEFS.forEach(([key], k) => { accKeys[k] += rows[i]?.[key] || 0; });
      const boundary = trendGran === "week"
        ? day.getDay() === (weekStart === "sunday" ? 0 : 1)
        : day.getDate() === 1;
      if (boundary && i > 0 && i > bucketStartIdx) {
        flush(bucketStartIdx, i - 1);
        bucketStartIdx = i;
      }
      if (i === list.length - 1) flush(bucketStartIdx, i);
    }
    return {
      labels,
      values,
      tips,
      series: SERIES_DEFS.map(([, , color], k) => ({ color, data: seriesAgg[k] })),
    };
  }, [trendSource, trendGran, weekStart, analytics]);

  const dailyChart = trend.labels.length > 0 && (
    <StackedBars
      className="tall"
      zoomable
      labels={trend.labels}
      series={trend.series}
      columnTip={(i, total) => {
        // 按天粒度保留构成/请求/缓存命中率明细；其余粒度用各自聚合提示
        if (trendGran !== "day") return trend.tips[i];
        const entry = (daily || [])[i] || {};
        return `<b>${entry.date || ""}</b>` +
          SERIES_DEFS.map(([key, name, color]) =>
            `<div class="tt-row"><span class="swatch" style="background:${color}"></span>${name}` +
            `<span class="tt-val">${fmtTokens(entry[key])}</span></div>`).join("") +
          `<div class="tt-row">${t("dash.ttTotal")}<span class="tt-val">${fmtTokens(total)}</span></div>` +
          `<div class="tt-row">${t("dash.ttRequests")}<span class="tt-val">${fmt(entry.requests)}</span></div>` +
          `<div class="tt-row">${t("dash.ttCacheHit")}<span class="tt-val">${fmtPct(entry.cache_hit_rate)}</span></div>`;
      }}
    />
  );

  const kpi = (analytics && analytics.kpi) || {};
  // 缓存命中率 KPI 用今日口径：取逐日桶最后一天（与后端逐日 cache_hit_rate 同口径），
  // 原 kpi.cache_hit_rate 是所选范围窗口口径，与"本周/今日"两张固定窗口卡不一致
  const todayCacheRate = daily && daily.length ? daily[daily.length - 1].cache_hit_rate : null;
  let wowHtml = "";
  if (kpi.week_over_week != null) {
    const percent = (kpi.week_over_week * 100).toFixed(1);
    const up = kpi.week_over_week >= 0;
    wowHtml = <span className={up ? "up" : "down"}>{up ? "+" : ""}{percent}%</span>;
  }

  // 升级执行（确认后异步进行；卡片显示动态提醒，结果落入升级提示条）
  const beginUpgrade = useCallback(async (targets) => {
    // 只拦截同目标的重复升级，其它组件可并发安装/升级
    const data = (usagePayload && usagePayload.data) || {};
    const duplicate = getUpgradingTargets(install, data).some((target) => targets.includes(target));
    if (duplicate) return;
    try {
      const result = await window.api.upgrade(targets, data.environment, data.windows_setup_script);
      setInstallResult({ ok: Boolean(result && result.ok), error: result && result.error });
    } catch (err) {
      setInstallResult({ ok: false, error: String(err.message || err) });
    } finally {
      // 升级完成后刷新用量数据（版本号变化）
      if (onRefresh) onRefresh();
    }
  }, [install.runs, usagePayload, onRefresh]);

  // 速率展示口径：设置页 speedMode = gen 时优先纯生成速率（无逐请求计时回退吞吐）
  const fmtRate = (v) => (v >= 100 ? abbrev(Math.round(v)) : v.toFixed(1));
  const pickRate = (item) =>
    speedMode === "gen" ? (item.gen_rate != null ? item.gen_rate : item.rate) : item.rate;
  const rateText = (item) => {
    const v = pickRate(item);
    return v != null ? `${fmtRate(v)} tok/s` : "—";
  };
  // agent/模型 展示：agent 取会话所属 CLI（kimi/kimi-work/codex/zcode/omp），而不是按
  // 模型名前缀的计费归因——自定义模型名带 deepseek/ 前缀时，Kimi Code 会话
  // 不再被显示成 DeepSeek。模型名自带的 provider 前缀只取末段，避免
  // kimi/kimi-code/k3-256k 这类双重前缀；悬浮提示保留完整模型名
  const rateModelLabel = (agent, model) => {
    const agentLabel = AGENT_LABELS[agent] || agent || "—";
    if (!model) return agentLabel;
    const bare = model.split("/").pop();
    if (!agent) return bare;
    return `${agentLabel}/${bare}`;
  };

  // 排序作用于全集；分组与 200 行渲染上限在排序之后套用。
  // 列组织（v0.7.25 重组）：Token 三列合一（总量 + 构成迷你条，悬浮看明细）、
  // 起止两列合一（活跃跨度 + 结束于），新增占比列——列数 12 → 9
  const sessionsAll = useMemo(() => (analytics && analytics.sessions) || [], [analytics]);
  const sessionsGrand = useMemo(
    () => sessionsAll.reduce((sum, s) => sum + (s.total || 0), 0),
    [sessionsAll],
  );
  // "x 分钟前"按分钟粒度刷新即可：避免 nowSec 每次渲染都让表格子树失效
  const nowMinute = Math.floor(Date.now() / 60000);
  const nowSec = nowMinute * 60;
  // 默认 100 行，点击"显示全部"才展开到 200 行上限
  const [showAllSessions, setShowAllSessions] = useState(false);
  const sessionsRowLimit = showAllSessions ? SESSION_ROW_CAP : SESSION_ROW_DEFAULT;
  // 首屏先画 KPI/图表，重会话表在浏览器空闲时再创建，避免一次性长任务
  const [sessionsReady, setSessionsReady] = useState(false);
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 120));
    const handle = idle(() => setSessionsReady(true), { timeout: 400 });
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
  }, []);
  const sortedRows = useMemo(
    () => sessionsAll.slice()
      .sort((a, b) => ((a[sessionsSort.key] || 0) - (b[sessionsSort.key] || 0)) * sessionsSort.dir),
    [sessionsAll, sessionsSort],
  );
  // 分组：组间按组内最近活跃时间降序（新建/刚改动的项目置顶），
  // 同刻再按组总 token、名称排序；组内沿用当前排序键，全局最多渲染 200 行。
  const groupPlan = useMemo(() => {
    if (sessionsGroup === "none") return null;
    const groups = new Map();
    for (const s of sortedRows) {
      const key = sessionsGroup === "project" ? (s.project || "(unknown)") : (s.agent || "?");
      if (!groups.has(key)) groups.set(key, { key, workDir: s.work_dir || "", rows: [], total: 0, last: 0 });
      const g = groups.get(key);
      g.rows.push(s);
      g.total += s.total || 0;
      g.last = Math.max(g.last, s.last || 0);
    }
    let left = sessionsRowLimit;
    return [...groups.values()]
      .sort((a, b) => b.last - a.last || b.total - a.total || a.key.localeCompare(b.key))
      .map((g) => {
        const shown = g.rows.slice(0, Math.max(0, left));
        left -= shown.length;
        return { ...g, shown };
      });
  }, [sortedRows, sessionsGroup, sessionsRowLimit]);
  const header = (key, label, left = false) => {
    const sortable = SESSION_SORTABLE.includes(key);
    const arrow = sessionsSort.key === key ? (sessionsSort.dir < 0 ? " ▼" : " ▲") : "";
    const toggleSort = () => {
      setSessionsSort((prev) => {
        const next = prev.key === key ? { key, dir: -prev.dir } : { key, dir: -1 };
        try { localStorage.setItem(SESSIONS_SORT_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    };
    return (
      <th
        className={`${sortable ? "sortable" : ""}${left ? " l" : ""}`}
        data-key={sortable ? key : undefined}
        role={sortable ? "button" : undefined}
        tabIndex={sortable ? 0 : undefined}
        onClick={() => {
          if (!sortable) return;
          toggleSort();
        }}
        onKeyDown={sortable ? activateOnKeys(toggleSort) : undefined}
      >
        {label}{arrow}
      </th>
    );
  };

  const renderSessionRow = (session) => {
    const comps = [
      ["input", session.input],
      ["output", session.output],
      ["cache_read", session.cache_read],
      ["cache_creation", session.cache_creation],
    ];
    const base = Math.max(1, session.total || 0);
    const share = sessionsGrand > 0 ? ((session.total || 0) / sessionsGrand) * 100 : 0;
    const ago = Math.max(0, nowSec - (session.last || 0));
    return (
      <tr key={session.session_id}>
        <td className="l mono" title={session.session_id}>
          {session.session_id.replace("session_", "").replace(/^codex-/, "").slice(0, 8)}…
        </td>
        <td className="l" title={session.work_dir}>{session.project}</td>
        <td className="l"><span className="sess-agent"><BrandIcon of={session.agent} size={12} />{AGENT_LABELS[session.agent] || session.agent}</span></td>
        <td className="l mono" title={(session.models || []).join(", ")}>
          {(session.models || []).length > 1
            ? `${session.models.length} models`
            : rateModelLabel(session.cli || session.agent, (session.models || [])[0])}
        </td>
        <td
          className="sess-tokens"
          title={comps.map(([key, value]) => `${key.replace("_", " ")}: ${fmtTokens(value)}`).join(" · ")}
        >
          <b>{fmtTokens(session.total)}</b>
          <span className="sess-bar">
            {comps.map(([key, value]) => value > 0 ? (
              <i key={key} style={{ width: `${((value / base) * 100).toFixed(1)}%`, background: `var(--c-${key})` }} />
            ) : null)}
          </span>
        </td>
        <td className="mono sess-share">{share.toFixed(1)}%</td>
        <td>{fmt(session.requests)}</td>
        <td
          className="l mono"
          title={`${fmtTimestamp(session.first, true)} → ${fmtTimestamp(session.last, true)}`}
        >
          {fmtSpan(Math.max(0, session.last - session.first))}
          <span className="sess-ago">
            {ago <= SESSION_LIVE_THRESHOLD_SEC
              ? ` · ${t("dash.sessLive")}`
              : ` · ${t("dash.rateEndedAgo").replace("{d}", fmtSpan(ago))}`}
          </span>
        </td>
        <td className="mono">{rateText(session)}</td>
      </tr>
    );
  };

  return (
    <div className="page page-flex">
      <header className="page-head">
        <div>
          <h1>{t("nav.analytics")}</h1>
          <div className="meta">
            {analytics
              ? t("dash.meta")
                .replace("{from}", analytics.date_range[0])
                .replace("{to}", analytics.date_range[1])
                .replace("{days}", analytics.days)
                .replace("{at}", analytics.generated_at)
              : t("state.loading")}
          </div>
        </div>
        <div className="head-controls">
          <label className="days-field">{t("dash.target")}
            <Select
              value={target}
              ariaLabel={t("dash.target")}
              onChange={(value) => {
                setTarget(value);
                try { localStorage.setItem(TARGET_KEY, value); } catch {}
              }}
              options={targets.map((item) => [item.id, targetLabel(item)])}
            />
          </label>
          <label className="days-field">{t("dash.agent")}
            <Select
              value={agent}
              ariaLabel={t("dash.agent")}
              onChange={(value) => {
                setAgent(value);
                try { localStorage.setItem(AGENT_KEY, value); } catch {}
              }}
              options={AGENT_FILTER_OPTIONS.map(([value, label]) =>
                [value, value === "all" ? t("dash.agentAll") : label])}
            />
          </label>
          <button
            type="button"
            className="btn refresh-inline"
            title={`${t("tip.refresh")} (F5)`}
            aria-keyshortcuts="F5"
            disabled={refreshing}
            onClick={() => onRefresh && onRefresh()}
          >
            <RefreshIcon spinning={refreshing} /> {t("tip.refresh")}
          </button>
        </div>
      </header>

      {/* 页头固定在滚动区外：右侧滚动条只出现在正文区域（header 之下） */}
      <div className="page-body">
      <div className={`error-card${analyticsError ? "" : " hidden"}`} style={{ margin: "0 0 12px" }}>
        {analyticsError}
      </div>
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-label">{t("dash.kpiWeek")}{agent !== "all" ? ` · ${AGENT_LABELS[agent]}` : ""}</div>
          <div className="kpi-value">{fmtTokens(kpi.week_total)}</div>
          <div className="kpi-sub">
            {wowHtml}
            {wowHtml ? ` ${t("dash.kpiWeekSub")}` : (kpi.prev_week_total > 0 ? "" : t("dash.kpiWeekSub"))}
            {kpi.prev_week_total > 0
              ? ` · ${t("dash.kpiWeekBase").replace("{v}", fmtTokens(kpi.prev_week_total))}`
              : ""}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t("dash.kpiToday")}</div>
          <div className="kpi-value">{fmtTokens(kpi.today_total)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t("dash.kpiCacheToday")}</div>
          <div className="kpi-value">{fmtPct(todayCacheRate)}</div>
        </div>
        {useMemo(() => (
        <div className={cardCls("rate", "kpi-card")}>
          <div className="kpi-label rate-label">
            <span className="rate-label-text">
              {lang === "zh"
                ? `${t("dash.kpiRate")}（${expandedCard === "rate" ? t("dash.rateActive1d") : t("dash.rateLatestHint")}）`
                : `${t("dash.kpiRate")} (${expandedCard === "rate" ? t("dash.rateActive1d") : t("dash.rateLatestHint")})`}
            </span>
            {expandBtn("rate")}
          </div>
          {expandedCard === "rate" ? (() => {
            // 全屏：近 1 天活跃明细（项目 → 会话 → 模型），旧版远端后端无此字段时回退空态
            const active = (kpi.rate || {}).active_1d;
            const projects = (active && active.projects) || [];
            if (!projects.length) {
              return <div className="status">{t("state.noData")}</div>;
            }
            const sessionCount = projects.reduce((n, p) => n + (p.sessions || []).length, 0);
            return (
              <>
                <div className="table-hint">
                  {t("dash.rateActiveSummary")
                    .replace("{p}", String(projects.length))
                    .replace("{n}", String(sessionCount))
                    .replace("{t}", fmtTokens(active.tokens || 0))}
                </div>
                <div className="act-list">
                  {projects.map((proj) => {
                    const collapsed = rateCollapsed.has(proj.name);
                    return (
                    <div className="act-proj" key={proj.name}>
                      <div className="act-proj-head">
                        {/* v0.7.32：头部恢复 0.7.30 原样式（名称左、统计右、无整头点击态），
                            折叠收放改为独立按钮并加大尺寸 */}
                        <button
                          type="button"
                          className={`act-proj-toggle${collapsed ? " closed" : ""}`}
                          aria-expanded={!collapsed}
                          title={collapsed ? t("dash.rateExpandProject") : t("dash.rateCollapseProject")}
                          onClick={() => toggleRateProject(proj.name)}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2.5 4.5 6 8l3.5-3.5" />
                          </svg>
                        </button>
                        <span className="act-proj-name" title={proj.path || proj.name}>{proj.name}</span>
                        <span className="act-proj-stats">
                          {fmtTokens(proj.tokens)} {t("dash.tokens")} · {t("dash.sessionsCount").replace("{n}", String((proj.sessions || []).length))}
                        </span>
                      </div>
                      {collapsed ? null : (proj.sessions || []).map((s) => {
                        // 最新用过的模型置顶；会话头速率取该模型自己的速率，
                        // 与顶部模型行保持一致（不再显示整段会话的加权平均）
                        const models = (s.models || []).slice().sort(
                          (a, b) => (b.last || 0) - (a.last || 0) || (b.tokens || 0) - (a.tokens || 0),
                        );
                        const latestModel = models[0];
                        return (
                        <div className="act-session" key={s.session_id}>
                          <div className="act-session-row">
                            <span className="mono act-sid" title={s.session_id}>
                              {String(s.session_id).replace("session_", "").replace(/^codex-/, "").slice(0, 8)}…
                            </span>
                            <span className="act-agent"><BrandIcon of={s.agent} size={11} />{AGENT_LABELS[s.agent] || s.agent}</span>
                            <span className="act-meta">
                              {fmtTokens(s.output)} out · {s.requests} req · {t("dash.rateEndedAgo").replace("{d}", fmtSpan(s.ended_ago_seconds || 0))}
                            </span>
                            <span className="act-rate" title={t(speedMode === "gen" ? "dash.speedHint" : "dash.speedHintThroughput")}>
                              {rateText(latestModel || s)}
                            </span>
                          </div>
                          <div className="act-models">
                            {models.map((m) => (
                              <div className="act-model-row" key={m.model}>
                                <span className="mono act-model-name" title={`${s.agent}/${m.model}`}>
                                  {rateModelLabel(s.cli || s.agent, m.model)}
                                </span>
                                <span className="act-meta">
                                  {fmtTokens(m.tokens)} {t("dash.tokens")} · {fmtTokens(m.output)} out · {m.requests} req
                                </span>
                                <span className="act-rate">{rateText(m)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                    );
                  })}
                </div>
              </>
            );
          })() : (() => {
            const latest = (kpi.rate || {}).latest_sessions || [];
            if (!latest.length) {
              return <div className="kpi-sub">{t("state.noData")}</div>;
            }
            // 同名项目出现多次时用 #1/#2/#3 区分（按最近活跃排序，#1 最新）；
            // 完整会话 id 在悬浮提示里，行内不再占空间
            const projCount = {};
            for (const item of latest) projCount[item.project] = (projCount[item.project] || 0) + 1;
            const projSeen = {};
            return (
              <div className="rate-rows">
                {latest.map((item) => {
                  const dupIdx = (projSeen[item.project] = (projSeen[item.project] || 0) + 1);
                  const tag = projCount[item.project] > 1 ? `#${dupIdx}` : null;
                  return (
                    <div
                      className="rate-row"
                      key={item.session_id || `${item.project}#${dupIdx}`}
                      title={`${item.project} · ${item.session_id || "?"} · ${item.model || item.agent} · ${t("dash.rateEndedAgo").replace("{d}", fmtSpan(item.ended_ago_seconds || 0))}`}
                    >
                      <span className="rate-name">{item.project}</span>
                      {tag ? <span className="rate-tag">{tag}</span> : null}
                      <span className="rate-model" title={item.model || item.agent || ""}>
                        <BrandIcon of={item.cli || item.agent} size={12} />
                        {rateModelLabel(item.cli || item.agent, item.model)}
                      </span>
                      <span className="rate-val">{rateText(item)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
        ), [kpi.rate, expandedCard, speedMode, rateCollapsed, lang, dragCard, dropTarget, nowMinute])}
      </div>

      <section className="block">
        <div className="quotas-head">
          <h2>{t("dash.quotas")}{agent !== "all" ? ` · ${AGENT_LABELS[agent]}` : ""}</h2>
          <button
            type="button"
            className={`qtoken-switch${quotaTokenMode === "tokens" ? " on" : ""}`}
            role="switch"
            aria-checked={quotaTokenMode === "tokens"}
            title={t("dash.quotaTokenToggle")}
            onClick={toggleQuotaTokenMode}
          >
            <span className="qtoken-track"><span className="qtoken-knob" /></span>
            <span className="qtoken-label">{t("dash.quotaTokenLabel")}</span>
          </button>
        </div>
        {usagePayload && usagePayload.error ? (
          <div className="quota-unavailable">
            {t("dash.quotaUnavailable")} — {usagePayload.error}
            <span>{t("dash.quotaUnavailableHint")}</span>
          </div>
        ) : null}
        <div className="quota-grid" style={{ marginTop: (usagePayload && usagePayload.error) ? 10 : 0 }}>
          {accounts.map((account) => (
            <QuotaCard
              key={`${account.provider}:${account.account_id || "default"}`}
              account={account}
              versions={versions}
              onUpgrade={setUpgradeProvider}
              upgrading={upgrading}
              providerKey={agentProviderKey(account.provider)}
              accountState={accountStates[agentProviderKey(account.provider)]}
              tokenMode={quotaTokenMode}
              estimates={quotaEstimates}
              onRefresh={onRefresh}
            />
          ))}
          {(usagePayload && !usagePayload.error ? shownErrors : []).map((err) => {
            const errorKey = `${err.provider}:${err.account_id || "default"}`;
            const providerKey = agentProviderKey(err.provider);
            const displayError = loginFeedback[errorKey] ? { ...err, login_feedback: loginFeedback[errorKey] } : err;
            return (<QuotaErrorCard
              key={`${err.provider}:${err.account_id || "default"}:${err.error}`}
              err={displayError}
              providerKey={providerKey}
              accountState={accountStates[providerKey]}
              refreshing={refreshing}
              onFix={async (action) => {
                if (action === "refresh") {
                  if (onRefresh) onRefresh();
                } else if (action === "login" && providerKey) {
                  setLoginFeedback((prev) => ({ ...prev, [errorKey]: { ok: true, text: t("err.loginStarting") } }));
                  const result = await window.api.loginAgent(providerKey, data && data.environment, err.account_id || "default");
                  if (!result || !result.ok) {
                    try { localStorage.setItem("env-tools.settings-focus-agent", providerKey); } catch {}
                    setLoginFeedback((prev) => ({ ...prev, [errorKey]: { ok: false, text: t("err.loginNeedsSettings") } }));
                    window.location.hash = "#/settings";
                  } else {
                    setLoginFeedback((prev) => ({ ...prev, [errorKey]: { ok: true, text: t("err.loginStarted") } }));
                    setTimeout(() => { if (onRefresh) onRefresh(); }, 1200);
                  }
                } else {
                  try { if (providerKey) localStorage.setItem("env-tools.settings-focus-agent", providerKey); } catch {}
                  window.location.hash = "#/settings";
                }
              }}
            />
            );
          })}
          {accounts.length === 0 && shownErrors.length === 0
            ? (usagePayload && !usagePayload.error
              ? <div className="status">{t("state.noData")}</div>
              : <div className="status">{t("state.loading")}</div>)
            : null}
        </div>
      </section>

      <QuotaWeeklyCard target={target} weekStart={weekStart} accounts={accounts} estimates={quotaEstimates} />

      <div className="dashboard-cards">
      <section
        {...cardMods("daily")}
        className={`${cardCls("daily")} card-w-full${dragCard === "daily" ? " dragging" : ""}${dropTarget === "daily" && dragCard && dragCard !== "daily" ? " drop-target" : ""}`}
      >
        <div className="card-head-row">
          {dragHandle("daily")}
          <h2>{t("dash.dailyTokens")}</h2>
          <div className="card-head-actions">
            {/* 粒度：按小时=今日 24 时 / 按天=近 30 天 / 按周=90 天 / 按月=365 天；
                图表支持 Ctrl+滚轮或右键横向拖动缩放 x 轴 */}
            <Select
              value={trendGran}
              ariaLabel={t("dash.dailyTokens")}
              onChange={(value) => {
                setTrendGran(value);
                try { localStorage.setItem(TREND_KEY, value); } catch {}
              }}
              options={[
                ["hourly", t("dash.trendHourly")],
                ["day", t("dash.trendDaily")],
                ["week", t("dash.trendWeekly")],
                ["month", t("dash.trendMonthly")],
              ]}
            />
            {expandBtn("daily")}
          </div>
        </div>
        <div className="legend">
          {SERIES_DEFS.map(([key, name, color]) => (
            <span className="item" key={key}>
              <span className="swatch" style={{ background: color }} />{name}
            </span>
          ))}
        </div>
        {trendNeed && !trendSource
          ? <div className="status">{t("state.loading")}</div>
          : trend.labels.length
            ? dailyChart
            : <div className="status">{t("state.noData")}</div>}
      </section>

      <section
        {...cardMods("yearly")}
        className={`${cardCls("yearly")} card-w-flex${dragCard === "yearly" ? " dragging" : ""}${dropTarget === "yearly" && dragCard && dragCard !== "yearly" ? " drop-target" : ""}`}
      >
          <div className="card-head-row">
            {dragHandle("yearly")}
            <h2>{t("dash.yearly")}</h2>
            {expandBtn("yearly")}
          </div>
          <CalendarHeatmap calendar={analytics && analytics.calendar} />
        </section>
        <section
          {...cardMods("share")}
          className={`${cardCls("share", "card card-model-share")} card-w-side${dragCard === "share" ? " dragging" : ""}${dropTarget === "share" && dragCard && dragCard !== "share" ? " drop-target" : ""}`}
        >
          <div className="card-head-row">
            {dragHandle("share")}
            <h2>{t("dash.modelShare")}</h2>
            {expandBtn("share")}
          </div>
          <DonutChart items={pieItems} />
        </section>

      <section
        {...cardMods("dailyModel")}
        className={`${cardCls("dailyModel")} card-w-full${dragCard === "dailyModel" ? " dragging" : ""}${dropTarget === "dailyModel" && dragCard && dragCard !== "dailyModel" ? " drop-target" : ""}`}
      >
        <div className="card-head-row">
          {dragHandle("dailyModel")}
          <h2>{t("dash.dailyModel")}</h2>
          {expandBtn("dailyModel")}
        </div>
        <div className="legend">
          {models.map((model, i) => (
            <span className="item" key={model}>
              <span className="swatch" style={{ background: MODEL_PALETTE[i % MODEL_PALETTE.length] }} />
              {model}
            </span>
          ))}
        </div>
        <StackedBars
          zoomable
          labels={shortDays}
          series={models.map((model, i) => ({
            color: MODEL_PALETTE[i % MODEL_PALETTE.length],
            data: dayList.map((day) => (dailyModel[day] || [])[i] || 0),
          }))}
          columnTip={(i) => {
            const date = dayList[i] || "";
            const perModel = dailyModel[date] || [];
            return `<b>${date}</b>` +
              models.map((model, j) => perModel[j]
                ? `<div class="tt-row"><span class="swatch" style="background:${MODEL_PALETTE[j % MODEL_PALETTE.length]}"></span>${model}` +
                  `<span class="tt-val">${fmtTokens(perModel[j])}</span></div>`
                : "").join("") +
              `<div class="tt-row">${t("dash.ttTotal")}<span class="tt-val">${fmtTokens(((daily || [])[i] || {}).total || 0)}</span></div>`;
          }}
        />
      </section>

      <section
        {...cardMods("cacheRate")}
        className={`${cardCls("cacheRate")} card-w-half${dragCard === "cacheRate" ? " dragging" : ""}${dropTarget === "cacheRate" && dragCard && dragCard !== "cacheRate" ? " drop-target" : ""}`}
      >
          <div className="card-head-row">
            {dragHandle("cacheRate")}
            <h2>{t("dash.cacheRate")}</h2>
            {expandBtn("cacheRate")}
          </div>
          <LineChart zoomable labels={shortDays} values={(daily || []).map((entry) => entry.cache_hit_rate)} />
        </section>
        <section
          {...cardMods("topProjects")}
          className={`${cardCls("topProjects")} card-w-half${dragCard === "topProjects" ? " dragging" : ""}${dropTarget === "topProjects" && dragCard && dragCard !== "topProjects" ? " drop-target" : ""}`}
        >
          <div className="card-head-row">
            {dragHandle("topProjects")}
            <h2>{t("dash.topProjects")}</h2>
            {expandBtn("topProjects")}
          </div>
          {(() => {
            // 常规视图前 10 够聚焦；铺满视图展示全部
            const ranked = (analytics && analytics.project_rank) || [];
            const shown = expandedCard === "topProjects" ? ranked : ranked.slice(0, 10);
            return shown.length
              ? <ProjectBars items={shown} />
              : <div className="status">{t("state.noData")}</div>;
          })()}
        </section>

      {useMemo(() => sessionsReady ? (
      <section
        {...cardMods("sessions")}
        className={`${cardCls("sessions")} card-w-full${dragCard === "sessions" ? " dragging" : ""}${dropTarget === "sessions" && dragCard && dragCard !== "sessions" ? " drop-target" : ""}`}
      >
        <div className="card-head-row">
          {dragHandle("sessions")}
          <h2>{t("dash.sessions")}</h2>
          <div className="card-head-actions">
            <label className="days-field">{t("dash.groupBy")}
              <Select
                value={sessionsGroup}
                ariaLabel={t("dash.groupBy")}
                onChange={(value) => {
                  setSessionsGroup(value);
                  try { localStorage.setItem(SESSIONS_GROUP_KEY, value); } catch {}
                }}
                options={SESSION_GROUP_OPTIONS.map((value) =>
                  [value, t(`dash.group${value[0].toUpperCase()}${value.slice(1)}`)])}
              />
            </label>
            {expandBtn("sessions")}
          </div>
        </div>
        <div className="table-hint">{t("dash.sessionsHint")}</div>
        <div className="table-hint" style={{ opacity: 0.7 }}>
          {speedMode === "gen" ? t("dash.speedHint") : t("dash.speedHintThroughput")}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {header("session", "Session", true)}
                {header("project", "Project", true)}
                {header("agent", "Agent", true)}
                {header("models", "Models", true)}
                {header("total", "Tokens")}
                {header("share", "Share")}
                {header("requests", "Reqs")}
                {header("last", "Activity", true)}
                {header("rate", "Speed")}
              </tr>
            </thead>
            {sessionsGroup === "none" ? (
              <tbody>
                {sortedRows.slice(0, sessionsRowLimit).map(renderSessionRow)}
              </tbody>
            ) : (
              (groupPlan || []).map((g) => (
                <tbody key={g.key}>
                  <tr className="group-row">
                    <td className="l" colSpan={9} title={g.workDir || g.key}>
                      {sessionsGroup === "agent" ? <BrandIcon of={g.key} size={13} /> : null}
                      {sessionsGroup === "agent" ? (AGENT_LABELS[g.key] || g.key) : g.key}
                      <span className="group-stats">
                        {t("dash.sessionsCount").replace("{n}", String(g.rows.length))} · {fmtTokens(g.total)} {t("dash.tokens")}
                        {sessionsGrand > 0 ? ` · ${((g.total / sessionsGrand) * 100).toFixed(1)}%` : ""}
                      </span>
                    </td>
                  </tr>
                  {g.shown.map(renderSessionRow)}
                </tbody>
              ))
            )}
          </table>
        </div>
        {sortedRows.length > SESSION_ROW_DEFAULT ? (
          <button
            type="button"
            className="login-btn sessions-more"
            onClick={() => setShowAllSessions((value) => !value)}
          >
            {showAllSessions
              ? t("dash.sessionsCollapse")
              : t("dash.sessionsShowAll").replace("{n}", String(Math.min(sortedRows.length, SESSION_ROW_CAP)))}
          </button>
        ) : null}
      </section>
      ) : (
        <section className="card-w-full sessions-placeholder"><div className="status">{t("state.loading")}</div></section>
      ), [sessionsReady, groupPlan, sortedRows, sessionsGrand, sessionsGroup, sessionsSort, speedMode, lang, dragCard, dropTarget, expandedCard, nowMinute, sessionsRowLimit, showAllSessions])}
      </div>
      {upgradeProvider && (
        <UpgradeOverlay
          provider={upgradeProvider}
          payload={usagePayload || { data: {} }}
          onClose={() => setUpgradeProvider(null)}
          onStart={(targets) => beginUpgrade(targets)}
        />
      )}
      </div>
    </div>
  );
}
