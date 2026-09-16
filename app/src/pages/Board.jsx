// 用量看板（小悬浮窗口）：紧凑配额卡片 + 设置页（全应用唯一入口）+ 升级浮层。
// 行为完全对齐 v0.2.0 的 renderer.js：provider 筛选、会员到期、版本徽章升级、
// 窗口高度自动贴合、拉窄折叠、错误卡片自动淡出。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fmtPct, fmtReset, fmtSpan, fmtTimestamp, isNewerVersion, levelClass, timeFractionOf,
  readThemePreference, writeThemePreference, applyTheme, resolvedTheme,
} from "../utils.js";

const ERROR_DISMISS_MS = 8000;
const DISPLAY_SELECTION_KEY = "ai-usage-monitor.display-providers";
const MEMBERSHIP_PROVIDERS = [
  ["kimi", "Kimi Code"],
  ["openai", "OpenAI Codex"],
  ["glm", "GLM"],
  ["deepseek", "DeepSeek"],
];

function toLocalInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function membershipEndStatus(endsAt, autoRenew = false) {
  const endMs = new Date(endsAt).getTime();
  if (!Number.isFinite(endMs)) return { text: "", ended: false };
  const seconds = Math.floor((endMs - Date.now()) / 1000);
  return seconds >= 0
    ? { text: `${autoRenew ? "renews" : "ends"} in ${fmtSpan(seconds)}`, ended: false }
    : { text: `ended ${fmtSpan(-seconds)} ago`, ended: true };
}

// --- 设置面板 -------------------------------------------------------------------

function ThemePanel() {
  const [preference, setPreference] = useState(readThemePreference());
  const options = [["system", "System"], ["dark", "Dark"], ["light", "Light"]];
  return (
    <div className="panel" id="panel-theme">
      <div className="panel-title">Theme</div>
      <div className="panel-hint">Applies immediately and is remembered on this machine.</div>
      {options.map(([value, label]) => (
        <div
          key={value}
          className={`env-option${preference === value ? " selected" : ""}`}
          onClick={() => {
            setPreference(value);
            writeThemePreference(value);
            applyTheme(value);
          }}
        >
          <span className="radio" />{label}
        </div>
      ))}
    </div>
  );
}

function DisplayPanel({ knownProviders, selectedProviders, onToggle, onToggleAll }) {
  const allSelected = knownProviders.length > 0 && selectedProviders.size === knownProviders.length;
  return (
    <div className="panel" id="panel-display">
      <div className="panel-title">Providers</div>
      <div className="panel-hint">Choose which models appear on the dashboard.</div>
      <div
        className="display-list-item"
        onClick={onToggleAll}
      >
        <span className={`cb${allSelected ? " on" : selectedProviders.size > 0 ? " partial" : ""}`} />
        All
      </div>
      {knownProviders.map((name) => (
        <div key={name} className="display-list-item" onClick={() => onToggle(name)}>
          <span className={`cb${selectedProviders.has(name) ? " on" : ""}`} />
          {name}
        </div>
      ))}
    </div>
  );
}

function MembershipPanel({ settings, onSaved }) {
  const [rows, setRows] = useState([]);
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const membership = (settings && settings.membership) || {};
    setRows(MEMBERSHIP_PROVIDERS.map(([key, label]) => {
      const entry = membership[key];
      return {
        key,
        label,
        date: entry ? toLocalInputValue(entry.purchased_at) : "",
        months: entry && entry.duration_months ? String(entry.duration_months) : "",
      };
    }));
  }, [settings]);
  const save = async () => {
    setSaving(true);
    setNote({ cls: "settings-note", text: "Saving…" });
    const values = {};
    for (const row of rows) {
      const months = parseInt(row.months, 10);
      values[row.key] = row.date
        ? { purchased_at: row.date, duration_months: Number.isInteger(months) && months > 0 ? months : 1 }
        : null;
    }
    try {
      const result = await window.api.setSettings({ membership: values });
      if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
      setNote({ cls: "settings-note ok", text: "Saved. Usage data is refreshing…" });
      onSaved(result);
    } catch (err) {
      setNote({ cls: "settings-note error", text: `Save failed: ${err.message || err}` });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="panel" id="panel-membership">
      <div className="panel-title">Membership</div>
      <div className="panel-hint">Set the purchase (or last renewal) date and the membership length; the dashboard shows when each membership ends. Dates use your local timezone. Leave a row empty to hide it — Kimi (with web credentials) and GLM then show the renewal date from their subscription APIs automatically.</div>
      {rows.map((row) => {
        const entry = (settings && settings.membership || {})[row.key];
        let stateText = "";
        let stateCls = "";
        if (entry && entry.error) { stateText = entry.error; stateCls = " error"; }
        else if (entry && entry.ends_at) {
          const status = membershipEndStatus(entry.ends_at, Boolean(entry.auto_renew));
          stateText = `${fmtTimestamp(entry.ends_at, true).slice(0, 16)} · ${status.text}`;
          stateCls = status.ended ? " ended" : "";
        }
        return (
          <div className="membership-row" key={row.key}>
            <div className="membership-name">
              <span>{row.label}</span>
              <span className={`membership-state${stateCls}`}>{stateText}</span>
            </div>
            <div className="membership-inputs">
              <input
                type="datetime-local" className="membership-date" value={row.date}
                onChange={(event) => setRows((prev) => prev.map((r) =>
                  r.key === row.key ? { ...r, date: event.target.value } : r))}
              />
              <input
                type="number" className="membership-months" min="1" max="120" step="1"
                placeholder="1" value={row.months}
                onChange={(event) => setRows((prev) => prev.map((r) =>
                  r.key === row.key ? { ...r, months: event.target.value } : r))}
              />
              <span className="membership-unit">months</span>
            </div>
          </div>
        );
      })}
      <div className={note.cls}>{note.text}</div>
      <div className="settings-actions">
        <button className="settings-save" disabled={saving} onClick={save}>Save</button>
      </div>
    </div>
  );
}

function LoginPanel({ currentSettings, lastPayload }) {
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const [busy, setBusy] = useState(false);
  const login = async (agent) => {
    setBusy(true);
    setNote({ cls: "settings-note", text: "Starting web authorization…" });
    try {
      const environment = (currentSettings && currentSettings.environment)
        || (lastPayload && lastPayload.data && lastPayload.data.environment);
      const result = await window.api.loginAgent(agent, environment);
      if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
      setNote({ cls: "settings-note ok", text: "Web authorization started. Finish it in your browser, then refresh." });
    } catch (err) {
      setNote({ cls: "settings-note error", text: `Login failed: ${err.message || err}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel" id="panel-login">
      <div className="panel-title">Agent Login</div>
      <div className="panel-hint">Start web authorization manually. The dashboard never opens a login page on its own.</div>
      <div className="login-row">
        <div className="login-info"><div className="login-name">Kimi Code</div><div className="login-method">Web authorization</div></div>
        <button className="login-btn" disabled={busy} onClick={() => login("kimi")}>Log in</button>
      </div>
      <div className="login-row">
        <div className="login-info"><div className="login-name">OpenAI Codex</div><div className="login-method">Web authorization</div></div>
        <button className="login-btn" disabled={busy} onClick={() => login("codex")}>Log in</button>
      </div>
      <div className={note.cls}>{note.text}</div>
    </div>
  );
}

function ApiKeysPanel({ settingsVersion }) {
  const inputs = { deepseek: useRef(null), glm: useRef(null) };
  const [states, setStates] = useState({
    deepseek: { text: "Checking…", cls: "" },
    glm: { text: "Checking…", cls: "" },
  });
  const [note, setNote] = useState({ cls: "settings-note", text: "Keys are sent to the backend through stdin only." });
  const [saving, setSaving] = useState(false);

  const showStatus = (provider, info = {}) => {
    if (info.configured) {
      setStates((prev) => ({ ...prev, [provider]: { text: `Configured (${info.source || "local"})`, cls: " configured" } }));
      if (inputs[provider].current) inputs[provider].current.placeholder = "Leave blank to keep current key";
    } else if (info.source === "invalid") {
      setStates((prev) => ({ ...prev, [provider]: { text: "Invalid credential file", cls: " invalid" } }));
      if (inputs[provider].current) inputs[provider].current.placeholder = "Enter a replacement key";
    } else {
      setStates((prev) => ({ ...prev, [provider]: { text: "Not configured", cls: "" } }));
      if (inputs[provider].current) inputs[provider].current.placeholder = "Enter API key";
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.getApiKeyStatus();
        if (cancelled) return;
        if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
        for (const provider of Object.keys(inputs)) {
          showStatus(provider, (result.status || {})[provider]);
        }
      } catch (err) {
        if (!cancelled) setNote({ cls: "settings-note error", text: `Cannot read key status: ${err.message || err}` });
      }
    })();
    return () => { cancelled = true; };
  }, [settingsVersion]);

  const save = async () => {
    const values = {};
    for (const [provider, ref] of Object.entries(inputs)) {
      const value = ref.current ? ref.current.value.trim() : "";
      if (value) values[provider] = value;
    }
    if (Object.keys(values).length === 0) {
      setNote({ cls: "settings-note error", text: "Enter at least one new API key." });
      return;
    }
    setSaving(true);
    setNote({ cls: "settings-note", text: "Saving…" });
    try {
      const result = await window.api.saveApiKeys(values);
      if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
      for (const provider of Object.keys(inputs)) {
        showStatus(provider, (result.status || {})[provider]);
        if (inputs[provider].current) inputs[provider].current.value = "";
      }
      setNote({ cls: "settings-note ok", text: "Saved. Usage data is refreshing…" });
    } catch (err) {
      setNote({ cls: "settings-note error", text: `Save failed: ${err.message || err}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" id="panel-apikeys">
      <div className="panel-title">API Keys</div>
      <div className="panel-hint">Keys are stored locally with private file permissions.</div>
      <div className="key-field">
        <div className="key-label"><span>DeepSeek</span><span className={`key-state${states.deepseek.cls}`}>{states.deepseek.text}</span></div>
        <input ref={inputs.deepseek} className="key-input" type="password" autoComplete="off" spellCheck={false} placeholder="Enter API key" />
      </div>
      <div className="key-field">
        <div className="key-label"><span>GLM / BigModel</span><span className={`key-state${states.glm.cls}`}>{states.glm.text}</span></div>
        <input ref={inputs.glm} className="key-input" type="password" autoComplete="off" spellCheck={false} placeholder="Enter API key" />
      </div>
      <div className={note.cls}>{note.text}</div>
      <div className="settings-actions">
        <button className="settings-save" disabled={saving} onClick={save}>Save</button>
      </div>
    </div>
  );
}

function EnvironmentPanel({ settings, onSaved }) {
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const available = (settings && settings.available_environments) || [];
  const wslDistros = (settings && settings.wsl_distros) || [];
  const current = (settings && settings.environment) || "";
  const [distro, setDistro] = useState((settings && settings.wsl_distro) || "");
  useEffect(() => {
    setDistro((prev) => (wslDistros.includes(prev) ? prev : (wslDistros[0] || "")));
  }, [wslDistros.join("|")]);
  if (available.length < 2 && wslDistros.length === 0) return null;
  const save = async (values) => {
    setNote({ cls: "settings-note", text: "Saving…" });
    try {
      const result = await window.api.setSettings(values);
      if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
      setNote({ cls: "settings-note ok", text: "Saved. Usage data is refreshing…" });
      onSaved(result.settings || {});
    } catch (err) {
      setNote({ cls: "settings-note error", text: `Save failed: ${err.message || err}` });
    }
  };
  return (
    <div className="panel" id="panel-environment">
      <div className="panel-title">Data Source</div>
      <div className="panel-hint">Agent versions and credentials may differ between WSL and Windows. The dashboard shows usage, versions and upgrades from the selected environment.</div>
      {available.map((env) => (
        <div
          key={env}
          className={`env-option${env === current ? " selected" : ""}`}
          onClick={() => {
            if (env === current) return;
            const values = { environment: env };
            if (env === "wsl" && distro) values.wsl_distro = distro;
            save(values);
          }}
        >
          <span className="radio" />{env}
        </div>
      ))}
      <div className={`wsl-distro-field${current === "wsl" && wslDistros.length ? "" : " hidden"}`}>
        <label className="wsl-distro-label" htmlFor="wsl-distro">WSL distribution</label>
        <select
          id="wsl-distro" className="wsl-distro-select" value={distro}
          onChange={(event) => {
            setDistro(event.target.value);
            if (current === "wsl" && event.target.value) save({ wsl_distro: event.target.value });
          }}
        >
          {wslDistros.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      <div className={note.cls}>{note.text}</div>
    </div>
  );
}

function UpdateSection() {
  const [status, setStatus] = useState({ text: "Not checked", available: false });
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenNote, setTokenNote] = useState("");

  useEffect(() => window.api.onUpdateProgress(({ phase, percent }) => {
    setProgress(`${phase} ${percent == null ? "" : percent + "%"}`);
  }), []);

  const check = async () => {
    setBusy(true);
    setStatus({ text: "Checking…", available: false });
    try {
      const result = await window.api.updateCheck();
      if (!result || !result.ok) {
        const failed = `Check failed: ${(result && result.error) || "unknown"}`;
        setStatus({
          text: /404|private/i.test(failed)
            ? failed + " — paste a GitHub token below if the repo is private"
            : failed,
          available: false,
        });
      } else if (result.available) {
        setStatus({ text: `Update available: v${result.latest} (current v${result.current})`, available: true });
      } else {
        setStatus({ text: `Up to date (v${result.current})`, available: false });
      }
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setBusy(true);
    setStatus({ text: progress ? `Upgrading — ${progress}` : "Preparing upgrade…", available: true });
    try {
      const result = await window.api.updateInstall();
      if (!result || !result.ok) {
        setStatus({ text: `Upgrade failed: ${(result && result.error) || "unknown"}`, available: true });
        setBusy(false);
      } else {
        setStatus({ text: "Upgraded — restarting…", available: false });
      }
    } catch (err) {
      setStatus({ text: `Upgrade failed: ${err.message || err}`, available: true });
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div className="about-row"><span>Update</span><strong>{status.text}</strong></div>
      <div className="settings-actions" style={{ justifyContent: "flex-start" }}>
        <button className="settings-save" disabled={busy} onClick={check}>Check for updates</button>
        {status.available && (
          <button className="settings-save" disabled={busy} onClick={install}>
            {progress ? `Upgrading ${progress}` : "Download & install"}
          </button>
        )}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 10, color: "var(--faint)", cursor: "pointer" }}>
          GitHub token (private repo)
        </summary>
        <div className="membership-inputs" style={{ marginTop: 6 }}>
          <input
            className="key-input" type="password" placeholder="ghp_… / github_pat_…"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          <button
            className="login-btn"
            disabled={!tokenInput.trim()}
            onClick={async () => {
              const result = await window.api.updateSetToken(tokenInput.trim());
              setTokenNote(result && result.ok ? "Saved." : `Failed: ${(result && result.error) || "?"}`);
              setTokenInput("");
            }}
          >
            Save
          </button>
        </div>
        {tokenNote ? <div className="settings-note">{tokenNote}</div> : null}
      </details>
    </div>
  );
}

function AboutPanel({ settings, backend }) {
  return (
    <div className="panel" id="panel-about">
      <div className="panel-title">About</div>
      <div className="about-row"><span>Version</span><strong>{settings ? `v${settings.version}` : "—"}</strong></div>
      <div className="about-row"><span>Data source</span><strong>{settings ? (settings.environment === "wsl" && settings.wsl_distro ? `WSL (${settings.wsl_distro})` : settings.environment) : "—"}</strong></div>
      <div className="about-row"><span>Backend</span><strong className="about-path">{settings ? settings.script : "—"}</strong></div>
      <div className="about-row"><span>API</span><strong>{backend ? backend.engine : "—"}</strong></div>
      <UpdateSection />
    </div>
  );
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activePanel, setActivePanel] = useState("display");
  const [settings, setSettings] = useState(null);
  const [backend, setBackend] = useState(null);
  const [selectedProviders, setSelectedProviders] = useState(new Set());
  const knownProviders = useRef([]);
  const savedProviders = useRef(null);
  const [dismissedErrors, setDismissedErrors] = useState({});
  const [fatalErrorDismissed, setFatalErrorDismissed] = useState("");
  const [upgradeProvider, setUpgradeProvider] = useState(null);
  const [compact, setCompact] = useState(false);
  const [pinned, setPinned] = useState(false);
  const settingsReload = useRef(0);

  try {
    if (savedProviders.current === null) {
      const stored = JSON.parse(localStorage.getItem(DISPLAY_SELECTION_KEY) || "null");
      if (Array.isArray(stored)) savedProviders.current = new Set(stored.filter((p) => typeof p === "string"));
    }
  } catch {}

  // provider 筛选初始化与维护
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

  const refreshSettings = useCallback(async () => {
    try {
      const result = await window.api.getSettings();
      if (result && result.ok) setSettings(result);
    } catch {}
    try { setBackend(await window.api.getBackendStatus()); } catch {}
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    window.api.settingsOpen(true);
    window.api.resetFit();
    refreshSettings();
    return () => {};
  }, [settingsOpen, refreshSettings]);

  useEffect(() => {
    window.api.getPinState().then(setPinned);
    return window.api.onOpenSettings(() => setSettingsOpen(true));
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
    if (settingsOpen) {
      document.body.classList.remove("compact");
      window.api.fitHeight(Math.max(document.body.offsetHeight, 200));
    } else {
      fitWindow();
    }
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
      }, ERROR_DISMISS_MS + i * 400);
    });
    return () => timers.forEach(clearTimeout);
  }, [visibleErrors.map((e) => `${e.provider}:${e.error}`).join("|")]);

  // 全局错误（如数据抓取超时）同样淡出，避免长期占据看板
  const fatalError = lastPayload && lastPayload.error;
  useEffect(() => {
    if (!fatalError) return;
    const timer = setTimeout(() => setFatalErrorDismissed(fatalError), ERROR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [fatalError]);

  const panel = (name) => `panel${activePanel === name ? "" : " hidden"}`;
  const environment = (settings && settings.environment)
    || (data && data.environment);

  return (
    <>
      {!settingsOpen && (
        <div className={`content${compact ? " compact" : ""}`}>
          {lastPayload && lastPayload.error && fatalErrorDismissed !== lastPayload.error && (
            <div className="error-card">{lastPayload.error}</div>
          )}
          {knownProviders.length > 0 && selectedProviders.size === 0 ? (
            <div className="status">No providers selected</div>
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
                    const status = membershipEndStatus(membership.ends_at, autoRenew);
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
          {!lastPayload && <div className="status">Loading…</div>}
          {lastPayload && !lastPayload.error && accounts.length === 0
            && knownProviders.length > 0 && selectedProviders.size > 0 && (
            <div className="status">No data</div>
          )}
        </div>
      )}

      {settingsOpen && (
        <div className="settings-view">
          <div className="settings-sidebar">
            <button
              className="settings-back"
              onClick={() => {
                setSettingsOpen(false);
                window.api.settingsOpen(false);
                window.api.resetFit();
              }}
            >
              ← Back
            </button>
            {[
              ["display", "Display"],
              ["theme", "Theme"],
              ["membership", "Membership"],
              ["login", "Login"],
              ["apikeys", "API Keys"],
              ["environment", "Environment"],
              ["about", "About"],
            ].map(([key, label]) => {
              if (key === "environment") {
                const available = (settings && settings.available_environments) || [];
                const distros = (settings && settings.wsl_distros) || [];
                if (available.length < 2 && distros.length === 0) return null;
              }
              return (
                <div
                  key={key}
                  className={`side-item${activePanel === key ? " active" : ""}`}
                  onClick={() => setActivePanel(key)}
                >
                  {label}
                </div>
              );
            })}
          </div>
          <div className="settings-main">
            <div className={panel("display")}>
              <DisplayPanel
                knownProviders={knownProviders.current}
                selectedProviders={selectedProviders}
                onToggle={(name) => {
                  setSelectedProviders((prev) => {
                    const next = new Set(prev);
                    if (next.has(name)) next.delete(name); else next.add(name);
                    try { localStorage.setItem(DISPLAY_SELECTION_KEY, JSON.stringify([...next])); } catch {}
                    return next;
                  });
                }}
                onToggleAll={() => {
                  setSelectedProviders((prev) => {
                    const all = knownProviders.current.length > 0 && prev.size === knownProviders.current.length;
                    const next = all ? new Set() : new Set(knownProviders.current);
                    try { localStorage.setItem(DISPLAY_SELECTION_KEY, JSON.stringify([...next])); } catch {}
                    return next;
                  });
                }}
              />
            </div>
            <div className={panel("theme")}>
              <ThemePanel />
            </div>
            <div className={panel("membership")}>
              <MembershipPanel
                settings={settings}
                onSaved={(result) => {
                  if (result.settings) setSettings((prev) => ({ ...(prev || {}), ...result.settings }));
                }}
              />
            </div>
            <div className={panel("login")}>
              <LoginPanel currentSettings={settings} lastPayload={lastPayload} />
            </div>
            <div className={panel("apikeys")}>
              <ApiKeysPanel settingsReload={settingsReload.current} />
            </div>
            <div className={panel("environment")}>
              <EnvironmentPanel
                settings={settings}
                onSaved={(next) => setSettings((prev) => ({ ...(prev || {}), ...next }))}
              />
            </div>
            <div className={panel("about")}>
              <AboutPanel settings={settings} backend={backend} />
            </div>
          </div>
        </div>
      )}

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
