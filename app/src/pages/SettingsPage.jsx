// 设置页（v0.7.0 起住主窗口内，侧边栏 + 主体布局；看板窗口不再承载设置）。
// 面板与原 Board 版一致：Display / Theme / Membership / Login / API Keys /
// Environment / About（含无凭证的版本升级）。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fmtSpan, fmtTimestamp, isNewerVersion,
  readThemePreference, writeThemePreference, applyTheme, resolvedTheme,
} from "../utils.js";

const MEMBERSHIP_PROVIDERS = [
  ["kimi", "Kimi Code"],
  ["openai", "OpenAI Codex"],
  ["glm", "GLM"],
  ["deepseek", "DeepSeek"],
];

const DISPLAY_SELECTION_KEY = "ai-usage-monitor.display-providers";

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

// --- 各设置面板 -----------------------------------------------------------------

function DisplayPanel({ lastPayload }) {
  const [knownProviders, setKnownProviders] = useState([]);
  const [selectedProviders, setSelectedProviders] = useState(new Set());

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
    setKnownProviders((prev) => {
      if (prev.join("|") === names.join("|")) return prev;
      return names;
    });
  }, [lastPayload]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(DISPLAY_SELECTION_KEY) || "null");
      if (Array.isArray(stored)) {
        setSelectedProviders(new Set(stored.filter((p) => typeof p === "string")));
        return;
      }
    } catch {}
    if (knownProviders.length > 0) setSelectedProviders(new Set(knownProviders));
  }, [knownProviders.join("|")]);

  const persist = (next) => {
    try { localStorage.setItem(DISPLAY_SELECTION_KEY, JSON.stringify([...next])); } catch {}
  };
  const allSelected = knownProviders.length > 0 && selectedProviders.size === knownProviders.length;

  return (
    <div className="panel" id="panel-display">
      <div className="panel-title">Display</div>
      <div className="panel-hint">Choose which providers appear on the compact board.</div>
      <div
        className="display-list-item"
        onClick={() => setSelectedProviders(allSelected ? new Set() : new Set(knownProviders))}
      >
        <span className={`cb${allSelected ? " on" : selectedProviders.size > 0 ? " partial" : ""}`} />
        All
      </div>
      {knownProviders.map((name) => (
        <div
          key={name}
          className="display-list-item"
          onClick={() => setSelectedProviders((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name); else next.add(name);
            persist(next);
            return next;
          })}
        >
          <span className={`cb${selectedProviders.has(name) ? " on" : ""}`} />
          {name}
        </div>
      ))}
    </div>
  );
}

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

function ApiKeysPanel({ reloadKey }) {
  const inputs = { deepseek: useRef(null), glm: useRef(null) };
  const [states, setStates] = useState({
    deepseek: { text: "Checking…", cls: "" },
    glm: { text: "Checking…", cls: "" },
  });
  const [note, setNote] = useState({ cls: "settings-note", text: "Keys are stored locally by the native backend." });
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
  }, [reloadKey]);

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
      <div className="panel-hint">Agent credentials may live in Windows and/or WSL. Quotas merge both automatically; this chooses the primary source for versions and upgrades.</div>
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

  useEffect(() => window.api.onUpdateProgress(({ phase, percent }) => {
    setProgress(`${phase} ${percent == null ? "" : percent + "%"}`);
  }), []);

  const check = async () => {
    setBusy(true);
    setStatus({ text: "Checking…", available: false });
    try {
      const result = await window.api.updateCheck();
      if (!result || !result.ok) {
        setStatus({ text: `Check failed: ${(result && result.error) || "unknown"}`, available: false });
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
      <div className="settings-note">Public GitHub release — no token required.</div>
    </div>
  );
}

function AboutPanel({ settings, backend }) {
  return (
    <div className="panel" id="panel-about">
      <div className="panel-title">About</div>
      <div className="about-row"><span>Version</span><strong>{settings ? `v${settings.version}` : "—"}</strong></div>
      <div className="about-row"><span>Data source</span><strong>{settings ? (settings.environment === "wsl" && settings.wsl_distro ? `WSL (${settings.wsl_distro})` : settings.environment) : "—"}</strong></div>
      <div className="about-row"><span>Backend</span><strong className="about-path">{backend ? backend.engine : "—"}</strong></div>
      <UpdateSection />
    </div>
  );
}

// --- 主组件：侧边栏 + 主体 -------------------------------------------------------

export default function SettingsPage({ lastPayload }) {
  const [activePanel, setActivePanel] = useState("display");
  const [settings, setSettings] = useState(null);
  const [backend, setBackend] = useState(null);
  const [apiKeysReload, setApiKeysReload] = useState(0);

  const refreshSettings = useCallback(async () => {
    try {
      const result = await window.api.getSettings();
      if (result && result.ok) setSettings(result);
    } catch {}
    try { setBackend(await window.api.getBackendStatus()); } catch {}
  }, []);

  useEffect(() => { refreshSettings(); }, [refreshSettings]);

  const panel = (name) => `panel${activePanel === name ? "" : " hidden"}`;

  return (
    <div className="settings-view main-settings">
      <div className="settings-sidebar">
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
          <DisplayPanel lastPayload={lastPayload} />
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
          <ApiKeysPanel reloadKey={apiKeysReload} />
        </div>
        <div className={panel("environment")}>
          <EnvironmentPanel
            settings={settings}
            onSaved={(next) => {
              setSettings((prev) => ({ ...(prev || {}), ...next }));
              setApiKeysReload((n) => n + 1);
            }}
          />
        </div>
        <div className={panel("about")}>
          <AboutPanel settings={settings} backend={backend} />
        </div>
      </div>
    </div>
  );
}
