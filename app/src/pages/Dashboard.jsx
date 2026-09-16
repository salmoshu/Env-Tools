// 全量窗口默认页：会话用量分析（多 agent）+ 套餐配额总览。
// 数据两条线：analytics 走 get-analytics（Rust 后端优先，python 兜底），
// 配额走 usage-update 广播（60s 定时 + did-finish-load 补推）。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_COLORS, AGENT_LABELS, abbrev, fmt, fmtPct, fmtReset, fmtSpan, fmtTimestamp,
  levelClass, timeFractionOf,
} from "../utils.js";
import {
  CalendarHeatmap, DonutChart, LineChart, MODEL_PALETTE,
  SERIES_DEFS, StackedBars, ProjectBars,
} from "../components/charts.jsx";

const ANALYTICS_REFRESH_MS = 5 * 60 * 1000;
const DAYS_KEY = "ai-usage-monitor.analytics-days";
const AGENT_KEY = "ai-usage-monitor.analytics-agent";
const TARGET_KEY = "ai-usage-monitor.target";

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

function QuotaCard({ account, versions }) {
  const updated = account.fetched_at
    ? new Date(account.fetched_at).toLocaleTimeString("en-GB", { hour12: false })
    : "";
  const version = (versions[account.provider] || {}).current;
  return (
    <div className="qcard">
      <div className="qcard-head">
        <span className="qname">{account.provider}</span>
        <span className="plan">{account.plan || "unknown"}</span>
        {version ? <span className="qupdated">v{version}</span> : null}
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
    </div>
  );
}

export default function Dashboard({ lastPayload }) {
  const [analytics, setAnalytics] = useState(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(() => {
    try { return localStorage.getItem(DAYS_KEY) || "30"; } catch { return "30"; }
  });
  const [agent, setAgent] = useState(() => {
    try { return localStorage.getItem(AGENT_KEY) || "all"; } catch { return "all"; }
  });
  const [targets, setTargets] = useState([{ id: "local", label: "This machine", kind: "local" }]);
  const [target, setTarget] = useState(() => {
    try { return localStorage.getItem(TARGET_KEY) || "local"; } catch { return "local"; }
  });
  const [usage, setUsage] = useState(null);
  const [sessionsSort, setSessionsSort] = useState({ key: "total", dir: -1 });
  const analyticsBusy = useRef(false);

  // 配额按目标路由：本地目标吃 60s 广播（lastPayload），远端目标走 get-usage
  const refreshUsage = useCallback(async (nextTarget) => {
    if (nextTarget === "local") return;
    try {
      const result = await window.api.getUsage(nextTarget);
      if (result && (result.data || result.error)) setUsage(result);
    } catch {}
  }, []);

  useEffect(() => {
    if (target !== "local") refreshUsage(target);
  }, [target, refreshUsage]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (target !== "local") refreshUsage(target);
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
      if (result && result.targets) setTargets(result.targets);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    requestAnalytics(days, agent, target);
    const timer = setInterval(() => requestAnalytics(days, agent, target), ANALYTICS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [days, agent, target, requestAnalytics]);

  const usagePayload = target === "local"
    ? lastPayload
    : (usage || { data: null });
  const data = usagePayload && usagePayload.data;
  const accounts = (data && data.accounts) || [];
  const errors = (data && data.errors) || [];
  const versions = (data && data.versions) || {};

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
          `<div class="tt-row">cache hit<span class="tt-val">${fmtPct(entry.cache_hit_rate)}</span></div>`;
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
        onClick={() => {
          if (!sortable) return;
          setSessionsSort((prev) => prev.key === key
            ? { key, dir: -prev.dir }
            : { key, dir: -1 });
        }}
      >
        {label}{arrow}
      </th>
    );
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Usage Analytics</h1>
          <div className="meta">
            {analytics
              ? `Range ${analytics.date_range[0]} – ${analytics.date_range[1]} (${analytics.days} days)` +
                ` · Updated ${analytics.generated_at} · Source ${analytics.source || "~ local sessions"}`
              : "Loading analytics…"}
          </div>
        </div>
        <div className="head-controls">
          <label className="days-field">Target
            <select
              className="control"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                try { localStorage.setItem(TARGET_KEY, event.target.value); } catch {}
              }}
            >
              {targets.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="days-field">Agent
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
          <label className="days-field">Range
            <select
              className="control"
              value={days}
              onChange={(event) => {
                setDays(event.target.value);
                try { localStorage.setItem(DAYS_KEY, event.target.value); } catch {}
              }}
            >
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
        </div>
      </header>

      <div className={`error-card${analyticsError ? "" : " hidden"}`} style={{ margin: "0 0 12px" }}>
        {analyticsError}
      </div>

      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-label">Tokens (7 days){agent !== "all" ? ` · ${AGENT_LABELS[agent]}` : ""}</div>
          <div className="kpi-value">{fmt(kpi.week_total)}</div>
          <div className="kpi-sub">{wowHtml}{wowHtml ? " vs prev week" : ""}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Tokens today</div>
          <div className="kpi-value">{fmt(kpi.today_total)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Cache hit rate</div>
          <div className="kpi-value">{fmtPct(kpi.cache_hit_rate)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active sessions</div>
          <div className="kpi-value">{fmt(kpi.active_sessions)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Previous week</div>
          <div className="kpi-value">{fmt(kpi.prev_week_total)}</div>
        </div>
      </div>

      {analytics && analytics.agent_rank && analytics.agent_rank.length > 0 && agent === "all" && (
        <div className="legend" style={{ marginBottom: 14 }}>
          {analytics.agent_rank.map((item) => (
            <span className="item" key={item.agent}>
              <span className="swatch" style={{ background: AGENT_COLORS[item.agent] || AGENT_COLORS.other }} />
              {AGENT_LABELS[item.agent] || item.agent} {abbrev(item.total)} · {fmt(item.requests)} req
            </span>
          ))}
        </div>
      )}

      <section className="block">
        <h2>Plan quotas</h2>
        {usagePayload && usagePayload.error ? (
          <div className="error-card" style={{ marginTop: 0 }}>
            Quota data unavailable — {usagePayload.error}
            <div style={{ opacity: 0.75, marginTop: 4 }}>
              Quotas come from the data engine of the selected target. Check the
              target's WSL/python setup, or press refresh to retry.
            </div>
          </div>
        ) : null}
        <div className="quota-grid" style={{ marginTop: (usagePayload && usagePayload.error) ? 10 : 0 }}>
          {accounts.length
            ? accounts.map((account) => (
              <QuotaCard key={account.provider} account={account} versions={versions} />
            ))
            : (usagePayload && !usagePayload.error
              ? <div className="status">No data</div>
              : <div className="status">Loading…</div>)}
        </div>
        <div>
          {errors.map((err) => (
            <div className="error-card" key={err.provider}>{err.provider}: {err.error}</div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Daily tokens</h2>
        <div className="legend">
          {SERIES_DEFS.map(([key, name, color]) => (
            <span className="item" key={key}>
              <span className="swatch" style={{ background: color }} />{name}
            </span>
          ))}
        </div>
        {dailyChart}
      </section>

      <section className="card">
        <h2>Today by hour</h2>
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
      </section>

      <div className="grid">
        <section className="card">
          <h2>Model share</h2>
          <DonutChart items={pieItems} />
        </section>
        <section className="card">
          <h2>Daily × model</h2>
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
        <section className="card">
          <h2>Cache hit rate (daily)</h2>
          <LineChart labels={shortDays} values={(daily || []).map((entry) => entry.cache_hit_rate)} />
        </section>
        <section className="card">
          <h2>Top projects</h2>
          {(analytics && analytics.project_rank || []).slice(0, 15).length
            ? <ProjectBars items={(analytics.project_rank || []).slice(0, 15)} />
            : <div className="status">No data</div>}
        </section>
      </div>

      <section className="card">
        <h2>Yearly activity</h2>
        <CalendarHeatmap calendar={analytics && analytics.calendar} />
      </section>

      <section className="card">
        <h2>Sessions</h2>
        <div className="table-hint">Click Start / End / Total headers to sort · showing up to 200 rows.</div>
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
    </div>
  );
}
