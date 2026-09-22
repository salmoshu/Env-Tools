// 全量窗口默认页：会话用量分析（多 agent）+ 套餐配额总览。
// 数据两条线：analytics 走 get-analytics（Rust 原生引擎），
// 配额走 usage-update 广播（60s 定时 + did-finish-load 补推）。
// v0.7.1：配额跟随 agent 筛选、目标默认"全部来源"、token 趋势折线图、i18n。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_COLORS, AGENT_LABELS, abbrev, activateOnKeys, fmt, fmtPct, fmtReset, fmtSpan, fmtTimestamp,
  isNewerVersion, levelClass, timeFractionOf,
} from "../utils.js";
import {
  CalendarHeatmap, DonutChart, LineChart, MODEL_PALETTE,
  SERIES_DEFS, StackedBars, ProjectBars, ValueLineChart,
} from "../components/charts.jsx";
import { RefreshIcon } from "../components/Titlebar.jsx";
import UpgradeOverlay from "../components/UpgradeOverlay.jsx";
import { t, useLang } from "../i18n.js";

const ANALYTICS_REFRESH_MS = 5 * 60 * 1000;
const DAYS_KEY = "ai-usage-monitor.analytics-days";
const AGENT_KEY = "ai-usage-monitor.analytics-agent";
const TARGET_KEY = "ai-usage-monitor.target";
const TREND_KEY = "ai-usage-monitor.trend-granularity";

const AGENT_PROVIDERS = {
  kimi: ["Kimi Code"],
  codex: ["OpenAI Codex"],
  glm: ["GLM"],
  deepseek: ["DeepSeek"],
};

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

function QuotaCard({ account, versions, onUpgrade }) {
  const updated = account.fetched_at
    ? new Date(account.fetched_at).toLocaleTimeString("en-GB", { hour12: false })
    : "";
  const info = versions[account.provider] || {};
  const newer = info.current && info.latest && isNewerVersion(info.latest, info.current);
  const resetCredits = account.rate_limit_reset_credits;
  return (
    <div className="qcard">
      <div className="qcard-head">
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
        <span className="plan">{account.plan || "unknown"}</span>
        <span className="qupdated">{updated}</span>
      </div>
      <MembershipLine account={account} />
      {(account.windows || []).map((w, index) => {
        const pct = w.used_percent == null ? 0 : Math.max(0, Math.min(100, w.used_percent));
        const fraction = timeFractionOf(w);
        const reset = fmtReset(w.reset_after_seconds);
        const tail = reset
          ? <span className="reset">{reset}</span>
          : (w.usage && account.provider !== "GLM"
            ? <span className="reset">Usage {w.usage}</span>
            : null);
        return (
          <div className="qquota" key={index}>
            <div className="qrow">
              <span>{w.label}</span>
              <span className="pct">{pct.toFixed(1)}%{tail ? " · " : ""}{tail}</span>
            </div>
            <div className="bar">
              <div className={`fill ${levelClass(pct)}`} style={{ width: `${pct}%` }} />
              {fraction != null
                ? <div className="marker" style={{ left: `${(fraction * 100).toFixed(1)}%` }} />
                : null}
            </div>
          </div>
        );
      })}
      {(() => {
        if (!resetCredits || typeof resetCredits !== "object") return null;
        const available = resetCredits.available_count;
        const applicable = resetCredits.applicable_available_count;
        if (available == null && applicable == null) return null;
        const parts = [];
        if (available != null) parts.push(`${available} remaining`);
        if (applicable != null) {
          parts.push(Number(applicable) > 0 ? `${applicable} usable now` : "not usable until limit reached");
        }
        return (
          <div className={`limit-resets${Number(applicable) > 0 ? " ready" : ""}`}>
            Reset chance: {parts.join(" · ")}
          </div>
        );
      })()}
      {(() => {
        const cards = account.reset_cards;
        if (!cards || typeof cards !== "object") return null;
        const five = Array.isArray(cards.five_hour) ? cards.five_hour : [];
        const week = Array.isArray(cards.week) ? cards.week : [];
        if (!five.length && !week.length) return null;
        const parts = [];
        if (five.length) parts.push(`5h ×${five.length}`);
        if (week.length) parts.push(`7d ×${week.length}`);
        const soonest = [...five, ...week]
          .map((c) => Number(c.expire_after_seconds))
          .filter((n) => Number.isFinite(n) && n > 0)
          .sort((a, b) => a - b)[0];
        let expiry = "";
        if (soonest) {
          const d = new Date(Date.now() + soonest * 1000);
          const pad = (n) => String(n).padStart(2, "0");
          expiry = ` · ${t("dash.resetChancesEarliest")} ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }
        return (
          <div className="limit-resets ready">
            {t("dash.resetChances")}: {parts.join(" · ")}{expiry}
          </div>
        );
      })()}
    </div>
  );
}

/** 配额异常占位卡片：按 provider 类型分级引导，API 型绝不引导"去登录" */
function QuotaErrorCard({ err, onFix }) {
  const [expanded, setExpanded] = useState(false);
  const message = String((err && err.error) || "Unknown error");
  const provider = String((err && err.provider) || "");
  const lower = message.toLowerCase();
  const isApiProvider = provider === "DeepSeek" || provider === "GLM";
  const kind = isApiProvider
    ? "keys"
    : /login|expired|unauthorized|401|credential|oauth|token/i.test(message)
      ? "login"
      : /api.?key|not set|configure|balance/i.test(lower)
        ? "keys"
        : "retry";
  const hints = { login: t("err.loginHint"), keys: t("err.keysHint"), retry: t("err.retryHint") };
  return (
    <div className="qcard qcard-error">
      <div className="qcard-head">
        <span className="qname">{provider}</span>
        <span className="plan">{t("dash.unavailable")}</span>
      </div>
      <div className="qerror-hint">{hints[kind]}</div>
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
        <button className="qerror-btn ghost" onClick={() => onFix && onFix("refresh")}>
          <RefreshIcon /> {t("state.retry")}
        </button>
      </div>
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
  const [days, setDays] = useState(() => {
    try { return localStorage.getItem(DAYS_KEY) || "30"; } catch { return "30"; }
  });
  const [agent, setAgent] = useState(() => {
    try { return localStorage.getItem(AGENT_KEY) || "all"; } catch { return "all"; }
  });
  const [targets, setTargets] = useState([
    { id: "aggregate", kind: "aggregate" },
    { id: "local", kind: "local", label: "local" },
  ]);
  const [target, setTarget] = useState(() => {
    try { return localStorage.getItem(TARGET_KEY) || "aggregate"; } catch { return "aggregate"; }
  });
  const [usage, setUsage] = useState(null);
  const [sessionsSort, setSessionsSort] = useState({ key: "total", dir: -1 });
  const [showHourly, setShowHourly] = useState(false);
  const [trendGran, setTrendGran] = useState(() => {
    try { return localStorage.getItem(TREND_KEY) || "day"; } catch { return "day"; }
  });
  const [trendAnalytics, setTrendAnalytics] = useState(null);
  const [upgradeProvider, setUpgradeProvider] = useState(null);
  const analyticsBusy = useRef(false);
  useLang();

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
    if (analyticsBusy.current) return;
    analyticsBusy.current = true;
    setBusy(true);
    try {
      const result = await window.api.getAnalytics(nextDays, nextAgent, nextTarget);
      if (result && result.ok && result.analytics) {
        setAnalytics(result.analytics);
        setAnalyticsError("");
      } else {
        setAnalyticsError((result && result.error) || "Analytics failed");
      }
    } catch (error) {
      setAnalyticsError(`Analytics failed: ${error.message || error}`);
    } finally {
      analyticsBusy.current = false;
      setBusy(false);
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

  // 年度趋势需要 12 个月数据：单独拉取，避免影响主视图的 days 选择
  useEffect(() => {
    if (trendGran !== "year") return;
    let cancelled = false;
    window.api.getAnalytics(365, agent, target).then((result) => {
      if (!cancelled && result && result.ok && result.analytics) setTrendAnalytics(result.analytics);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [trendGran, agent, target]);

  const usagePayload = target === "local" || target === "aggregate"
    ? lastPayload
    : (usage || { data: null });
  const data = usagePayload && usagePayload.data;
  const errors = (data && data.errors) || [];
  const versions = (data && data.versions) || {};
  const allAccounts = (data && data.accounts) || [];
  // agent 筛选联动配额：只看 kimi 时配额区只显示 Kimi
  const accounts = filterByAgent(allAccounts, agent);
  const shownErrors = filterByAgent(errors, agent);

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
  if (otherTotal > 0) pieItems.push({ name: "other", value: otherTotal, color: "#6b7385" });

  const daily = analytics && analytics.daily;
  const dailyProjectsMap = (analytics && analytics.daily_projects) || {};

  // --- token 趋势（日/周/年） ---
  const trendSource = trendGran === "year" ? (trendAnalytics || analytics) : analytics;
  const trend = useMemo(() => {
    const list = (trendSource && trendSource.day_list) || [];
    const rows = (trendSource && trendSource.daily) || [];
    const dailyProjectsMap = (trendSource && trendSource.daily_projects) || {};
    const tip = (label, projects, value) =>
      `<b>${label}</b><div class="tt-row"><span class="tt-val">${t("dash.tokens")}: ${fmt(value || 0)}</span></div>` +
      projects.map((p, i) => `<div class="tt-row"><span class="tt-val">${i + 1}. ${p[0]} · ${fmt(p[1])}</span></div>`).join("");
    if (trendGran === "day") {
      return {
        labels: list.map(shortDateLabel),
        values: rows.map((e) => e.total || 0),
        tips: list.map((day, i) =>
          tip(shortDateLabel(day), (dailyProjectsMap[day] || []).slice(0, 3).map((p) => [p.name, p.total]), rows[i]?.total)),
      };
    }
    const labels = [];
    const values = [];
    const tips = [];
    let acc = 0;
    let bucketStartIdx = 0;
    const flush = (startIdx, endIdx) => {
      const agg = {};
      for (let i = startIdx; i <= endIdx; i++) {
        for (const p of (dailyProjectsMap[list[i]] || [])) agg[p.name] = (agg[p.name] || 0) + p.total;
      }
      const projects = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const label = trendGran === "week"
        ? list[startIdx].slice(5)
        : `${MONTH_SHORT[Number(list[startIdx].slice(5, 7)) - 1]}`;
      labels.push(label);
      values.push(acc);
      tips.push(tip(label, projects, acc));
    };
    for (let i = 0; i < list.length; i++) {
      const day = new Date(`${list[i]}T00:00:00`);
      acc += rows[i]?.total || 0;
      const boundary = trendGran === "week" ? day.getDay() === 1 : day.getDate() === 1;
      if (boundary && i > 0 && i > bucketStartIdx) {
        flush(bucketStartIdx, i - 1);
        bucketStartIdx = i;
      }
      if (i === list.length - 1) flush(bucketStartIdx, i);
    }
    return { labels, values, tips };
  }, [trendSource, trendGran]);

  const dailyChart = daily && (
    <StackedBars
      className="tall"
      labels={shortDays}
      series={SERIES_DEFS.map(([key, , color]) => ({ color, data: daily.map((e) => e[key]) }))}
      columnTip={(i, total) => {
        const entry = daily[i] || {};
        return `<b>${entry.date || ""}</b>` +
          SERIES_DEFS.map(([key, name, color]) =>
            `<div class="tt-row"><span class="swatch" style="background:${color}"></span>${name}` +
            `<span class="tt-val">${fmt(entry[key])}</span></div>`).join("") +
          `<div class="tt-row">total<span class="tt-val">${fmt(total)}</span></div>` +
          `<div class="tt-row">requests<span class="tt-val">${fmt(entry.requests)}</span></div>` +
          `<div class="tt-row">cache hit<span class="tt-val">${fmtPct(entry.cache_hit_rate)}</span></div>` +
          (dailyProjectsMap[entry.date] || []).slice(0, 3).map((p, j) =>
            `<div class="tt-row"><span class="tt-val">${j + 1}. ${p.name} · ${fmt(p.total)}</span></div>`).join("");
      }}
    />
  );

  const hourly = (analytics && analytics.today_hourly) || [];
  const kpi = (analytics && analytics.kpi) || {};
  let wowHtml = "";
  if (kpi.week_over_week != null) {
    const percent = (kpi.week_over_week * 100).toFixed(1);
    const up = kpi.week_over_week >= 0;
    wowHtml = <span className={up ? "up" : "down"}>{up ? "+" : ""}{percent}%</span>;
  }

  const rows = (analytics && analytics.sessions || []).slice()
    .sort((a, b) => ((a[sessionsSort.key] || 0) - (b[sessionsSort.key] || 0)) * sessionsSort.dir)
    .slice(0, 200);
  const header = (key, label, left = false) => {
    const sortable = ["first", "last", "total"].includes(key);
    const arrow = sessionsSort.key === key ? (sessionsSort.dir < 0 ? " ▼" : " ▲") : "";
    return (
      <th
        className={`${sortable ? "sortable" : ""}${left ? " l" : ""}`}
        data-key={sortable ? key : undefined}
        role={sortable ? "button" : undefined}
        tabIndex={sortable ? 0 : undefined}
        onClick={() => {
          if (!sortable) return;
          setSessionsSort((prev) => prev.key === key
            ? { key, dir: -prev.dir }
            : { key, dir: -1 });
        }}
        onKeyDown={sortable ? activateOnKeys(() => {
          setSessionsSort((prev) => prev.key === key
            ? { key, dir: -prev.dir }
            : { key, dir: -1 });
        }) : undefined}
      >
        {label}{arrow}
      </th>
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
                .replace("{src}", analytics.source || "~ local sessions")
              : t("state.loading")}
          </div>
        </div>
        <div className="head-controls">
          <label className="days-field">{t("dash.target")}
            <select
              className="control"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                try { localStorage.setItem(TARGET_KEY, event.target.value); } catch {}
              }}
            >
              {targets.map((item) => (
                <option key={item.id} value={item.id}>{targetLabel(item)}</option>
              ))}
            </select>
          </label>
          <label className="days-field">{t("dash.agent")}
            <select
              className="control"
              value={agent}
              onChange={(event) => {
                setAgent(event.target.value);
                try { localStorage.setItem(AGENT_KEY, event.target.value); } catch {}
              }}
            >
              {Object.entries(AGENT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="days-field">{t("dash.range")}
            <select
              className="control"
              value={days}
              onChange={(event) => {
                setDays(event.target.value);
                try { localStorage.setItem(DAYS_KEY, event.target.value); } catch {}
              }}
            >
              <option value="7">{t("dash.range7")}</option>
              <option value="14">{t("dash.range14")}</option>
              <option value="30">{t("dash.range30")}</option>
              <option value="90">{t("dash.range90")}</option>
            </select>
          </label>
          <button
            type="button"
            className="btn refresh-inline"
            title={t("tip.refresh")}
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
          <div className="kpi-value">{fmt(kpi.week_total)}</div>
          <div className="kpi-sub">{wowHtml}{wowHtml ? ` ${t("dash.vsPrevWeek")}` : ""}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t("dash.kpiToday")}</div>
          <div className="kpi-value">{fmt(kpi.today_total)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t("dash.kpiCache")}</div>
          <div className="kpi-value">{fmtPct(kpi.cache_hit_rate)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t("dash.kpiSessions")}</div>
          <div className="kpi-value">{fmt(kpi.active_sessions)}</div>
        </div>
      </div>

      <section className="block">
        <h2>{target === "aggregate" ? t("dash.quotasMerged") : t("dash.quotas")}{agent !== "all" ? ` · ${AGENT_LABELS[agent]}` : ""}</h2>
        {usagePayload && usagePayload.error ? (
          <div className="quota-unavailable">
            {t("dash.quotaUnavailable")} — {usagePayload.error}
            <span>{t("dash.quotaUnavailableHint")}</span>
          </div>
        ) : null}
        <div className="quota-grid" style={{ marginTop: (usagePayload && usagePayload.error) ? 10 : 0 }}>
          {accounts.map((account) => (
            <QuotaCard
              key={account.provider}
              account={account}
              versions={versions}
              onUpgrade={target === "local" ? setUpgradeProvider : null}
            />
          ))}
          {(usagePayload && !usagePayload.error ? shownErrors : []).map((err) => (
            <QuotaErrorCard
              key={`${err.provider}:${err.error}`}
              err={err}
              onFix={(action) => {
                if (action === "refresh") {
                  if (onRefresh) onRefresh();
                } else {
                  window.location.hash = "#/settings";
                }
              }}
            />
          ))}
          {accounts.length === 0 && shownErrors.length === 0
            ? (usagePayload && !usagePayload.error
              ? <div className="status">{t("state.noData")}</div>
              : <div className="status">{t("state.loading")}</div>)
            : null}
        </div>
      </section>

      <section className="card">
        <div className="card-head-row">
          <h2>{t("dash.dailyTokens")}</h2>
          <button
            type="button"
            className="refresh-inline"
            onClick={() => setShowHourly((v) => !v)}
          >
            {t("dash.hourly")} {showHourly ? "▾" : "▸"}
          </button>
        </div>
        <div className="legend">
          {SERIES_DEFS.map(([key, name, color]) => (
            <span className="item" key={key}>
              <span className="swatch" style={{ background: color }} />{name}
            </span>
          ))}
        </div>
        {dailyChart}
        {showHourly && (
          <>
            <h2 style={{ marginTop: 14 }}>{t("dash.hourly")}</h2>
            <div className="legend">
              {SERIES_DEFS.slice(0, 3).map(([key, name, color]) => (
                <span className="item" key={key}>
                  <span className="swatch" style={{ background: color }} />{name}
                </span>
              ))}
            </div>
            <StackedBars
              labels={hourly.map((entry) => String(entry.hour).padStart(2, "0"))}
              series={SERIES_DEFS.map(([key, , color]) => ({ color, data: hourly.map((entry) => entry[key]) }))}
              columnTip={(i, total) => {
                const entry = hourly[i] || {};
                return `<b>${String(i).padStart(2, "0")}:00 – ${String(i).padStart(2, "0")}:59</b>` +
                  SERIES_DEFS.map(([key, name, color]) =>
                    `<div class="tt-row"><span class="swatch" style="background:${color}"></span>${name}` +
                    `<span class="tt-val">${fmt(entry[key])}</span></div>`).join("") +
                  `<div class="tt-row">total<span class="tt-val">${fmt(total)}</span></div>` +
                  `<div class="tt-row">requests<span class="tt-val">${fmt(entry.requests)}</span></div>`;
              }}
            />
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head-row">
          <h2>{t("dash.trend")}</h2>
          <select
            className="control"
            value={trendGran}
            onChange={(event) => {
              setTrendGran(event.target.value);
              try { localStorage.setItem(TREND_KEY, event.target.value); } catch {}
            }}
          >
            <option value="day">{t("dash.trendDaily")}</option>
            <option value="week">{t("dash.trendWeekly")}</option>
            <option value="year">{t("dash.trendYearly")}</option>
          </select>
        </div>
        {trendGran === "year" && !trendAnalytics
          ? <div className="status">{t("dash.trendYearlyHint")}</div>
          : trend.labels.length
            ? <ValueLineChart labels={trend.labels} values={trend.values} valueLabel={t("dash.tokens")} toolTips={trend.tips} />
            : <div className="status">{t("state.noData")}</div>}
      </section>

      <div className="row-yearly">
        <section className="card">
          <h2>{t("dash.yearly")}</h2>
          <CalendarHeatmap calendar={analytics && analytics.calendar} />
        </section>
        <section className="card card-model-share">
          <h2>{t("dash.modelShare")}</h2>
          <DonutChart items={pieItems} />
        </section>
      </div>

      <section className="card">
        <h2>{t("dash.dailyModel")}</h2>
        <div className="legend">
          {models.map((model, i) => (
            <span className="item" key={model}>
              <span className="swatch" style={{ background: MODEL_PALETTE[i % MODEL_PALETTE.length] }} />
              {model}
            </span>
          ))}
        </div>
        <StackedBars
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
                  `<span class="tt-val">${fmt(perModel[j])}</span></div>`
                : "").join("") +
              `<div class="tt-row">total<span class="tt-val">${fmt(((daily || [])[i] || {}).total || 0)}</span></div>`;
          }}
        />
      </section>

      <div className="grid">
        <section className="card">
          <h2>{t("dash.cacheRate")}</h2>
          <LineChart labels={shortDays} values={(daily || []).map((entry) => entry.cache_hit_rate)} />
        </section>
        <section className="card">
          <h2>{t("dash.topProjects")}</h2>
          {(analytics && analytics.project_rank || []).slice(0, 15).length
            ? <ProjectBars items={(analytics.project_rank || []).slice(0, 15)} />
            : <div className="status">{t("state.noData")}</div>}
        </section>
      </div>

      <section className="card">
        <h2>{t("dash.sessions")}</h2>
        <div className="table-hint">{t("dash.sessionsHint")}</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {header("session", "Session", true)}
                {header("project", "Project", true)}
                {header("agent", "Agent", true)}
                {header("models", "Models", true)}
                {header("input", "Input")}
                {header("output", "Output")}
                {header("cache", "CacheRead")}
                {header("requests", "Requests")}
                {header("first", "Start", true)}
                {header("last", "End", true)}
                {header("total", "Total")}
              </tr>
            </thead>
            <tbody>
              {rows.map((session) => (
                <tr key={session.session_id}>
                  <td className="l mono" title={session.session_id}>
                    {session.session_id.replace("session_", "").replace(/^codex-/, "").slice(0, 8)}…
                  </td>
                  <td className="l" title={session.work_dir}>{session.project}</td>
                  <td className="l">{session.agent}</td>
                  <td className="l mono" title={(session.models || []).join(", ")}>
                    {(session.models || []).length > 1
                      ? `${session.models.length} models`
                      : ((session.models || [])[0] || "-")}
                  </td>
                  <td>{fmt(session.input)}</td>
                  <td>{fmt(session.output)}</td>
                  <td>{fmt(session.cache_read)}</td>
                  <td>{fmt(session.requests)}</td>
                  <td className="l mono">{fmtTimestamp(session.first)}</td>
                  <td className="l mono">{fmtTimestamp(session.last)}</td>
                  <td><b>{fmt(session.total)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {upgradeProvider && (
        <UpgradeOverlay
          provider={upgradeProvider}
          payload={usagePayload || { data: {} }}
          onClose={() => setUpgradeProvider(null)}
        />
      )}
      </div>
    </div>
  );
}
