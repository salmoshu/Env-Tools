// 用量看板（小悬浮窗口）：紧凑配额卡片 + 升级浮层。
// v0.7.0 起设置全部迁入主窗口的 SettingsPage，本窗口只保留看板本身；
// provider 显示筛选仍由设置页管理，本窗口从 localStorage 读取。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fmtSpan, isNewerVersion, levelClass, timeFractionOf, fmtReset,
} from "../utils.js";
import { t, useLang } from "../i18n.js";

const DISPLAY_SELECTION_KEY = "ai-usage-monitor.display-providers";

// --- 升级浮层 -------------------------------------------------------------------

function UpgradeOverlay({ provider, payload, onClose }) {
  const [phase, setPhase] = useState("confirm"); // confirm | running | done | failed
  const [message, setMessage] = useState("");
  const [log, setLog] = useState([]);
  const logRef = useRef(null);
  const targetsRef = useRef([provider]);

  useEffect(() => {
    const versions = (payload.data && payload.data.versions) || {};
    const outdated = Object.keys(versions).filter((key) => {
      const info = versions[key] || {};
      return info.current && info.latest && isNewerVersion(info.latest, info.current);
    });
    targetsRef.current = outdated.length > 1 ? outdated : [provider];
  }, []);

  useEffect(() => {
    return window.api.onInstallProgress(({ line }) => {
      if (!line) return;
      setLog((prev) => [...prev.slice(-30), line]);
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }, []);

  const start = async (targets) => {
    setPhase("running");
    setMessage(`Upgrading ${targets.join(", ")} …`);
    const startedAt = Date.now();
    const elapsed = setInterval(() => {
      setMessage(`Upgrading ${targets.join(", ")} … (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }, 1000);
    try {
      const data = (payload && payload.data) || {};
      const result = await window.api.upgrade(targets, data.environment, data.windows_setup_script);
      clearInterval(elapsed);
      if (result && result.ok) {
        setMessage("Upgrade finished");
        setPhase("done");
        setTimeout(onClose, 1600);
      } else {
        setMessage(`Upgrade failed: ${(result && result.error) || "unknown error"}`);
        setPhase("failed");
      }
    } catch (err) {
      clearInterval(elapsed);
      setMessage(`Upgrade failed: ${err.message || err}`);
      setPhase("failed");
    }
  };

  const versions = (payload.data && payload.data.versions) || {};
  const info = versions[provider] || {};
  const outdated = Object.keys(versions).filter((key) => {
    const item = versions[key] || {};
    return item.current && item.latest && isNewerVersion(item.latest, item.current);
  });

  return (
    <div className="overlay">
      <div className="dialog">
        <div className="dialog-title">{provider}</div>
        <div className="dialog-ver">v{info.current} → {info.latest}</div>
        {phase === "confirm" && (
          <div className="dialog-btns">
            <button onClick={() => start([provider])}>Upgrade {provider}</button>
            {outdated.length > 1 && (
              <button onClick={() => start(outdated)}>Upgrade all ({outdated.length})</button>
            )}
            <button className="ghost" onClick={onClose}>Cancel</button>
          </div>
        )}
        {phase === "running" && (
          <>
            <div className="dialog-msg">{message}</div>
            <div className="install-log" ref={logRef}>
              {log.slice(-4).map((line, i) => <div key={i}>{line}</div>)}
            </div>
            <div className="dialog-btns">
              <button
                className="ghost"
                onClick={async (event) => {
                  event.target.disabled = true;
                  event.target.textContent = "Cancelling …";
                  try { await window.api.cancelInstall(); } catch {}
                }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
        {phase === "done" && <div className="dialog-msg">{message}</div>}
        {phase === "failed" && (
          <>
            <div className="dialog-msg">{message}</div>
            <div className="install-log" ref={logRef}>
              {log.slice(-8).map((line, i) => <div key={i}>{line}</div>)}
            </div>
            <div className="dialog-btns">
              <button className="ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- 主组件 ---------------------------------------------------------------------

export default function Board({ lastPayload }) {
  const [selectedProviders, setSelectedProviders] = useState(new Set());
  const knownProviders = useRef([]);
  const savedProviders = useRef(null);
  const [dismissedErrors, setDismissedErrors] = useState({});
  const [fatalErrorDismissed, setFatalErrorDismissed] = useState("");
  const [upgradeProvider, setUpgradeProvider] = useState(null);
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
          const next = new Set(names.filter((name) => storedSet.has(name)));
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
                    title="Click to upgrade"
                    onClick={() => setUpgradeProvider(account.provider)}
                  >
                    v{info.current} <span className="new">→ {info.latest}</span>
                  </span>
                ) : info.current ? (
                  <span className="ver">v{info.current}</span>
                ) : null}
                <span className="plan">{account.plan || "unknown"}</span>
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
                if (available != null) parts.push(`${available} remaining`);
                if (applicable != null) {
                  parts.push(Number(applicable) > 0 ? `${applicable} usable now` : "Not usable until limit reached");
                }
                return (
                  <div className={`limit-resets${Number(applicable) > 0 ? " ready" : ""}`}>
                    Reset chance: {parts.join(" · ")}
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
        />
      )}
    </>
  );
}
