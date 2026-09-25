// 用量看板（小悬浮窗口）：紧凑配额卡片 + 升级浮层。
// v0.7.0 起设置全部迁入主窗口的 SettingsPage，本窗口只保留看板本身；
// provider 显示筛选仍由设置页管理，本窗口从 localStorage 读取。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateOnKeys, fmtSpan, isNewerVersion, levelClass, timeFractionOf, fmtReset,
} from "../utils.js";
import { t, useLang } from "../i18n.js";
import { useInstallState, setInstallRunning, setInstallResult, dismissInstallResult } from "../installState.js";
import UpgradeOverlay from "../components/UpgradeOverlay.jsx";

const DISPLAY_SELECTION_KEY = "ai-usage-monitor.display-providers";


// --- 主组件 ---------------------------------------------------------------------

export default function Board({ lastPayload }) {
  const [selectedProviders, setSelectedProviders] = useState(new Set());
  const knownProviders = useRef([]);
  const savedProviders = useRef(null);
  const [dismissedErrors, setDismissedErrors] = useState({});
  const [fatalErrorDismissed, setFatalErrorDismissed] = useState("");
  const [upgradeProvider, setUpgradeProvider] = useState(null);
  const install = useInstallState();
  const upgrading = install.running;
  const [compact, setCompact] = useState(false);
  const [pinned, setPinned] = useState(false);
  useLang();

  try {
    if (savedProviders.current === null) {
      const stored = JSON.parse(localStorage.getItem(DISPLAY_SELECTION_KEY) || "null");
      if (Array.isArray(stored)) savedProviders.current = new Set(stored.filter((p) => typeof p === "string"));
    }
  } catch {}

  // provider 筛选初始化与维护；usage-update 会把设置页的筛选变更带回
  //（跨窗口 localStorage 不实时，这里以 payload 触发的重读兜底）
  useEffect(() => {
    if (!lastPayload || !lastPayload.data) return;
    const names = (lastPayload.data.accounts || []).map((a) => a.provider);
    const seen = new Set(names);
    for (const err of (lastPayload.data.errors || [])) {
      const p = err && err.provider;
      if (p && p !== "Kimi Monthly Total" && !seen.has(p)) {
        seen.add(p);
        names.push(p);
      }
    }
    try {
      const stored = JSON.parse(localStorage.getItem(DISPLAY_SELECTION_KEY) || "null");
      if (Array.isArray(stored)) {
        const storedSet = new Set(stored.filter((p) => typeof p === "string"));
        savedProviders.current = null;
        setSelectedProviders((prev) => {
          const prevKey = [...prev].sort().join("|");
          let next = new Set(names.filter((name) => storedSet.has(name)));
          // 自愈：筛选结果为空（旧数据/全被过滤）时回退为显示全部，避免看板空白
          if (next.size === 0 && names.length > 0) next = new Set(names);
          const nextKey = [...next].sort().join("|");
          return prevKey === nextKey ? prev : next;
        });
        knownProviders.current = names;
        return;
      }
    } catch {}
    const prevAll = knownProviders.current.length > 0
      && selectedProviders.size === knownProviders.current.length;
    if (knownProviders.current.length === 0 && names.length > 0) {
      const next = savedProviders.current === null
        ? new Set(names)
        : new Set(names.filter((name) => savedProviders.current.has(name)));
      savedProviders.current = null;
      setSelectedProviders(next);
      try { localStorage.setItem(DISPLAY_SELECTION_KEY, JSON.stringify([...next])); } catch {}
    } else if (prevAll) {
      setSelectedProviders(new Set(names));
    } else {
      setSelectedProviders((prev) => new Set([...prev].filter((name) => names.includes(name))));
    }
    knownProviders.current = names;
  }, [lastPayload]);

  useEffect(() => {
    window.api.getPinState().then(setPinned);
    return () => {};
  }, []);

  // 升级执行（确认后异步进行；卡片显示动态提醒，结果落入升级提示条）
  const beginUpgrade = useCallback(async (targets) => {
    if (install.running) return;
    setInstallRunning({ label: targets.join(", "), kind: "upgrade", targets });
    try {
      const data = (lastPayload && lastPayload.data) || {};
      const result = await window.api.upgrade(targets, data.environment, data.windows_setup_script);
      setInstallResult({ ok: Boolean(result && result.ok), error: result && result.error });
    } catch (err) {
      setInstallResult({ ok: false, error: String(err.message || err) });
    }
  }, [install.running, lastPayload]);

  useEffect(() => {
    const onResize = () => {
      const natural = document.body.offsetHeight;
      setCompact(window.innerHeight < natural - 4);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const fitWindow = useCallback(() => {
    requestAnimationFrame(() => {
      // 必须在未折叠状态下测量,否则会得到"只含文字"的偏小高度
      document.body.classList.remove("compact");
      window.api.fitHeight(document.body.offsetHeight);
    });
  }, []);

  useEffect(() => {
    fitWindow();
  });

  // 升级结果提示条自动消失：成功 4s、失败 10s（也可手动 ×）
  useEffect(() => {
    if (!install.result || install.running) return;
    const ms = install.result.ok ? 4000 : 10000;
    const timer = setTimeout(() => dismissInstallResult(), ms);
    return () => clearTimeout(timer);
  }, [install.result, install.running]);

  const data = lastPayload && lastPayload.data;
  const accounts = ((data && data.accounts) || [])
    .filter((a) => selectedProviders.has(a.provider));
  const visibleErrors = ((data && data.errors) || [])
    .filter((e) => selectedProviders.has(e.provider) && !dismissedErrors[`${e.provider}:${e.error}`]);
  const versions = (data && data.versions) || {};

  // 错误卡片自动淡出
  useEffect(() => {
    const timers = visibleErrors.map((err, i) => {
      const key = `${err.provider}:${err.error}`;
      return setTimeout(() => {
        setDismissedErrors((prev) => ({ ...prev, [key]: true }));
      }, 8000 + i * 400);
    });
    return () => timers.forEach(clearTimeout);
  }, [visibleErrors.map((e) => `${e.provider}:${e.error}`).join("|")]);

  // 全局错误（如数据抓取超时）同样淡出，避免长期占据看板
  const fatalError = lastPayload && lastPayload.error;
  useEffect(() => {
    if (!fatalError) return;
    const timer = setTimeout(() => setFatalErrorDismissed(fatalError), 8000);
    return () => clearTimeout(timer);
  }, [fatalError]);

  return (
    <>
      {install.result && !install.running ? (
        <div className={`upgrade-toast${install.result.ok ? "" : " err"}`}>
          {install.result.ok ? t("upgrade.done") : `${t("upgrade.failed")}: ${install.result.error || ""}`}
          <button type="button" className="toast-close" onClick={() => dismissInstallResult()}>×</button>
        </div>
      ) : null}
      <div className={`content${compact ? " compact" : ""}`}>
        {lastPayload && lastPayload.error && fatalErrorDismissed !== lastPayload.error && (
          <div className="error-card">{lastPayload.error}</div>
        )}
        {knownProviders.length > 0 && selectedProviders.size === 0 ? (
          <div className="status">{t("board.noProviders")}</div>
        ) : null}
        {accounts.map((account) => {
          const updated = account.fetched_at
            ? new Date(account.fetched_at).toLocaleTimeString("en-GB", { hour12: false })
            : "";
          const info = versions[account.provider] || {};
          const membership = account.membership;
          return (
            <div className="provider" key={account.provider}>
              <div className="provider-head">
                <span className="provider-name">{account.provider}</span>
                {info.current && info.latest && isNewerVersion(info.latest, info.current) ? (
                  <span
                    className="ver upgrade"
                    role="button"
                    tabIndex={0}
                    title="Click to upgrade"
                    onClick={() => setUpgradeProvider(account.provider)}
                    onKeyDown={activateOnKeys(() => setUpgradeProvider(account.provider))}
                  >
                    v{info.current} <span className="new">→ {info.latest}</span>
                  </span>
                ) : info.current ? (
                  <span className="ver">v{info.current}</span>
                ) : null}
                <span className="plan">{account.plan || "unknown"}</span>
                {upgrading && Array.isArray(upgrading.targets) && upgrading.targets.includes(account.provider) ? (
                  <span className="upgrading-badge"><span className="spin-dot" />{t("upgrade.runningBadge")}</span>
                ) : null}
                <span className="updated">{updated}</span>
              </div>
              {membership && membership.error ? (
                <div className="membership error">{membership.error}</div>
              ) : membership && membership.purchased_at && membership.ends_at ? (
                (() => {
                  const autoRenew = Boolean(membership.auto_renew);
                  const endMs = new Date(membership.ends_at).getTime();
                  if (!Number.isFinite(endMs)) return null;
                  const seconds = Math.floor((endMs - Date.now()) / 1000);
                  const status = seconds >= 0
                    ? { text: `${autoRenew ? "renews" : "ends"} in ${fmtSpan(seconds)}`, ended: false }
                    : { text: `ended ${fmtSpan(-seconds)} ago`, ended: true };
                  const pad = (n) => String(n).padStart(2, "0");
                  const endDate = new Date(membership.ends_at);
                  return (
                    <div className="membership">
                      <div className={`membership-end${status.ended ? " ended" : ""}`}>
                        <span>{autoRenew ? "Renews" : "Ends"}</span>
                        <strong>
                          {endDate.getFullYear()}-{pad(endDate.getMonth() + 1)}-{pad(endDate.getDate())}{" "}
                          {pad(endDate.getHours())}:{pad(endDate.getMinutes())}:{pad(endDate.getSeconds())}
                        </strong>
                        <em>{status.text}</em>
                      </div>
                    </div>
                  );
                })()
              ) : null}
              {(account.windows || []).map((w, index) => {
                const pct = w.used_percent == null ? 0 : Math.max(0, Math.min(100, w.used_percent));
                const fraction = timeFractionOf(w);
                const resetText = fmtReset(w.reset_after_seconds);
                const showUsage = w.usage && account.provider !== "GLM";
                return (
                  <div className="quota" key={index}>
                    <div className="quota-row">
                      <span>{w.label}</span>
                      <span className="pct">
                        {pct.toFixed(1)}%
                        {resetText ? <span className="reset"> · {resetText}</span> : null}
                        {showUsage ? <span className="usage"> · Usage {w.usage}</span> : null}
                      </span>
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
                const resetCredits = account.rate_limit_reset_credits;
                if (!resetCredits || typeof resetCredits !== "object") return null;
                const available = resetCredits.available_count;
                const applicable = resetCredits.applicable_available_count;
                if (available == null && applicable == null) return null;
                const parts = [];
                if (available != null) parts.push(t("dash.resetRemaining").replace("{n}", String(available)));
                if (applicable != null) {
                  parts.push(Number(applicable) > 0 ? t("dash.resetUsableNow") : t("dash.resetAfterLimit"));
                }
                return (
                  <div className={`limit-resets${Number(applicable) > 0 ? " ready" : ""}`}>
                    {t("dash.resetChances")}: {parts.join(" · ")}
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
        })}
        {visibleErrors.map((err) => (
          <div className="error-card" key={`${err.provider}:${err.error}`}>
            {err.provider}: {err.error}
          </div>
        ))}
        {!lastPayload && <div className="status">{t("state.loading")}</div>}
        {lastPayload && !lastPayload.error && accounts.length === 0
          && knownProviders.length > 0 && selectedProviders.size > 0 && (
          <div className="status">{t("state.noData")}</div>
        )}
      </div>

      {upgradeProvider && (
        <UpgradeOverlay
          provider={upgradeProvider}
          payload={lastPayload || { data: {} }}
          onClose={() => setUpgradeProvider(null)}
          onStart={(targets) => beginUpgrade(targets)}
        />
      )}
    </>
  );
}
