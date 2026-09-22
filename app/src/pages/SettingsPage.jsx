// 设置页（主窗口内，侧边栏 + 主体布局；侧边栏顶部带返回按钮）。
// 侧边栏按 外观 / 账户 / 环境 / 关于 四组归类（组标题 + 条目缩进）；
// 主体滚动区内是一层居中列（.settings-column），面板标题/提示在外，
// 控件组统一包进 .settings-card 卡片。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateOnKeys, fmtSpan,
  readThemePreference, writeThemePreference, applyTheme,
} from "../utils.js";
import { t, useLang, setLang, getLang } from "../i18n.js";

// 用量账户 provider 显示名 → 设置 membership 小节键
const MEMBERSHIP_PROVIDERS = [
  ["kimi", "Kimi Code"],
  ["openai", "OpenAI Codex"],
  ["glm", "GLM"],
  ["deepseek", "DeepSeek"],
];

const UPDATE_PHASE_KEYS = {
  download: "settings.phaseDownload",
  install: "settings.phaseInstall",
  extract: "settings.phaseExtract",
  restart: "settings.phaseRestart",
};

const DISPLAY_SELECTION_KEY = "ai-usage-monitor.display-providers";

function toLocalInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ISO 时间（或 epoch 秒）→ "YYYY-MM-DD HH:mm" 本地格式
function fmtLocalMinute(value) {
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    setKnownProviders((prev) => (prev.join("|") === names.join("|") ? prev : names));
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
      <div className="panel-title">{t("settings.displayTitle")}</div>
      <div className="panel-hint">{t("settings.displayHint")}</div>
      <div className="settings-card">
        <div
          className="display-list-item"
          role="button"
          tabIndex={0}
          onClick={() => setSelectedProviders(allSelected ? new Set() : new Set(knownProviders))}
          onKeyDown={activateOnKeys(() => setSelectedProviders(allSelected ? new Set() : new Set(knownProviders)))}
        >
          <span className={`cb${allSelected ? " on" : selectedProviders.size > 0 ? " partial" : ""}`} />
          {t("settings.all")}
        </div>
        {knownProviders.map((name) => (
          <div
            key={name}
            className="display-list-item"
            role="button"
            tabIndex={0}
            onClick={() => setSelectedProviders((prev) => {
              const next = new Set(prev);
              if (next.has(name)) next.delete(name); else next.add(name);
              persist(next);
              return next;
            })}
            onKeyDown={activateOnKeys(() => setSelectedProviders((prev) => {
              const next = new Set(prev);
              if (next.has(name)) next.delete(name); else next.add(name);
              persist(next);
              return next;
            }))}
          >
            <span className={`cb${selectedProviders.has(name) ? " on" : ""}`} />
            {name}
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemePanel() {
  const [preference, setPreference] = useState(readThemePreference());
  const options = [["system", t("settings.themeSystem")], ["dark", t("settings.themeDark")], ["light", t("settings.themeLight")]];
  return (
    <div className="panel" id="panel-theme">
      <div className="panel-title">{t("settings.theme")}</div>
      <div className="panel-hint">{t("settings.themeHint")}</div>
      <div className="settings-card">
        {options.map(([value, label]) => (
          <div
            key={value}
            className={`env-option${preference === value ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              setPreference(value);
              writeThemePreference(value);
              applyTheme(value);
            }}
            onKeyDown={activateOnKeys(() => {
              setPreference(value);
              writeThemePreference(value);
              applyTheme(value);
            })}
          >
            <span className="radio" />{label}
          </div>
        ))}
      </div>
    </div>
  );
}

function LanguagePanel() {
  const [lang, setLangState] = useState(getLang());
  const options = [["en", "English"], ["zh", "中文"]];
  return (
    <div className="panel" id="panel-language">
      <div className="panel-title">{t("settings.language")}</div>
      <div className="panel-hint">{t("settings.langHint")}</div>
      <div className="settings-card">
        {options.map(([value, label]) => (
          <div
            key={value}
            className={`env-option${lang === value ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              setLang(value);
              setLangState(value);
            }}
            onKeyDown={activateOnKeys(() => {
              setLang(value);
              setLangState(value);
            })}
          >
            <span className="radio" />{label}
          </div>
        ))}
      </div>
    </div>
  );
}

// 会员面板：每行三态 —— 手动配置（可编辑，回填 purchased_at/duration_months）/
// 自动获取（provider 订阅接口给出 ends_at，禁用输入并标注，不随保存提交）/
// 可编辑空行。保存后触发 window.api.refresh() 让看板立即刷新。
function MembershipPanel({ settings, lastPayload, onSaved }) {
  const [rows, setRows] = useState([]);
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const [saving, setSaving] = useState(false);

  // 可编辑字段只在 settings 变化时重建，避免用量推送冲刷输入中的内容
  useEffect(() => {
    const membership = (settings && settings.membership) || {};
    setRows(MEMBERSHIP_PROVIDERS.map(([key, label]) => {
      const entry = membership[key];
      const manual = Boolean(entry && !entry.error && entry.purchased_at);
      return {
        key,
        label,
        manual,
        date: manual ? toLocalInputValue(entry.purchased_at) : "",
        months: manual && entry.duration_months ? String(entry.duration_months) : "",
      };
    }));
  }, [settings]);

  const membership = (settings && settings.membership) || {};
  const accounts = (lastPayload && lastPayload.data && lastPayload.data.accounts) || [];

  // 自动获取状态在渲染时从 lastPayload 派生（随用量推送实时更新）
  const rowsWithAuto = rows.map((row) => {
    if (row.manual) return { ...row, auto: false, autoEndsAt: null, autoError: null };
    const account = accounts.find((a) => a.provider === row.label);
    const accountMembership = account && account.membership;
    if (accountMembership && accountMembership.error) {
      return { ...row, auto: false, autoEndsAt: null, autoError: accountMembership.error };
    }
    const endsAt = accountMembership && accountMembership.ends_at;
    return { ...row, auto: Boolean(endsAt), autoEndsAt: endsAt || null, autoError: null };
  });

  const save = async () => {
    setSaving(true);
    setNote({ cls: "settings-note", text: t("state.saving") });
    const values = {};
    for (const row of rowsWithAuto) {
      if (row.auto) continue; // 自动获取行不提交、不清除
      const months = parseInt(row.months, 10);
      values[row.key] = row.date
        ? { purchased_at: row.date, duration_months: Number.isInteger(months) && months > 0 ? months : 1 }
        : null;
    }
    try {
      const result = await window.api.setSettings({ membership: values });
      if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
      setNote({ cls: "settings-note ok", text: t("state.saved") });
      onSaved(result);
      try { window.api.refresh(); } catch {}
    } catch (err) {
      setNote({ cls: "settings-note error", text: `${t("state.saveFailed")}: ${err.message || err}` });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="panel" id="panel-membership">
      <div className="panel-title">{t("settings.membership")}</div>
      <div className="panel-hint">{t("settings.membershipHint")}</div>
      <div className="settings-card">
        {rowsWithAuto.map((row) => {
          const entry = membership[row.key];
          let stateText = "";
          let stateCls = "";
          if (entry && entry.error) {
            stateText = entry.error; stateCls = " error";
          } else if (row.manual && entry && entry.ends_at) {
            const status = membershipEndStatus(entry.ends_at, Boolean(entry.auto_renew));
            stateText = `${fmtLocalMinute(entry.ends_at)} · ${status.text}`;
            stateCls = status.ended ? " ended" : "";
          } else if (row.auto) {
            const status = membershipEndStatus(row.autoEndsAt);
            stateText = `${fmtLocalMinute(row.autoEndsAt)} · ${status.text}`;
            stateCls = status.ended ? " ended" : "";
          } else if (row.autoError) {
            stateText = row.autoError; stateCls = " error";
          }
          return (
            <div className="membership-row" key={row.key}>
              <div className="membership-name">
                <span>
                  {row.label}
                  {row.auto && <span className="membership-auto">{t("settings.membershipAuto")}</span>}
                </span>
                <span className={`membership-state${stateCls}`}>{stateText}</span>
              </div>
              <div className="membership-inputs">
                <input
                  type="datetime-local" className="membership-date" value={row.date}
                  disabled={row.auto}
                  onChange={(event) => setRows((prev) => prev.map((r) =>
                    r.key === row.key ? { ...r, date: event.target.value } : r))}
                />
                <input
                  type="number" className="membership-months" min="1" max="120" step="1"
                  placeholder="1" value={row.months}
                  disabled={row.auto}
                  onChange={(event) => setRows((prev) => prev.map((r) =>
                    r.key === row.key ? { ...r, months: event.target.value } : r))}
                />
                <span className="membership-unit">{t("settings.membershipMonths")}</span>
              </div>
            </div>
          );
        })}
        <div className={note.cls}>{note.text}</div>
        <div className="settings-actions">
          <button type="button" className="settings-save" disabled={saving} onClick={save}>{t("state.save")}</button>
        </div>
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
      setNote({ cls: "settings-note ok", text: t("settings.loginStarted") });
    } catch (err) {
      setNote({ cls: "settings-note error", text: `${t("state.saveFailed")}: ${err.message || err}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel" id="panel-login">
      <div className="panel-title">{t("settings.loginTitle")}</div>
      <div className="panel-hint">{t("settings.loginHint")}</div>
      <div className="settings-card">
        <div className="login-row">
          <div className="login-info"><div className="login-name">Kimi Code</div><div className="login-method">{t("settings.loginMethod")}</div></div>
          <button type="button" className="login-btn" disabled={busy} onClick={() => login("kimi")}>{t("settings.loginBtn")}</button>
        </div>
        <div className="login-row">
          <div className="login-info"><div className="login-name">OpenAI Codex</div><div className="login-method">{t("settings.loginMethod")}</div></div>
          <button type="button" className="login-btn" disabled={busy} onClick={() => login("codex")}>{t("settings.loginBtn")}</button>
        </div>
        <div className={note.cls}>{note.text}</div>
      </div>
    </div>
  );
}

function ApiKeysPanel({ reloadKey }) {
  const inputs = { deepseek: useRef(null), glm: useRef(null) };
  const [states, setStates] = useState({
    deepseek: { text: "Checking…", cls: "" },
    glm: { text: "Checking…", cls: "" },
  });
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
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
    setNote({ cls: "settings-note", text: t("state.saving") });
    try {
      const result = await window.api.saveApiKeys(values);
      if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
      for (const provider of Object.keys(inputs)) {
        showStatus(provider, (result.status || {})[provider]);
        if (inputs[provider].current) inputs[provider].current.value = "";
      }
      setNote({ cls: "settings-note ok", text: t("state.saved") });
    } catch (err) {
      setNote({ cls: "settings-note error", text: `${t("state.saveFailed")}: ${err.message || err}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" id="panel-apikeys">
      <div className="panel-title">{t("settings.apikeys")}</div>
      <div className="panel-hint">{t("settings.apiKeysHint")}</div>
      <div className="settings-card">
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
          <button type="button" className="settings-save" disabled={saving} onClick={save}>{t("state.save")}</button>
        </div>
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
    setNote({ cls: "settings-note", text: t("state.saving") });
    try {
      const result = await window.api.setSettings(values);
      if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
      setNote({ cls: "settings-note ok", text: t("state.saved") });
      onSaved(result.settings || {});
    } catch (err) {
      setNote({ cls: "settings-note error", text: `${t("state.saveFailed")}: ${err.message || err}` });
    }
  };
  return (
    <div className="panel" id="panel-environment">
      <div className="panel-title">{t("settings.envTitle")}</div>
      <div className="panel-hint">{t("settings.envHint")}</div>
      <div className="settings-card">
        {available.map((env) => (
          <div
            key={env}
            className={`env-option${env === current ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (env === current) return;
              const values = { environment: env };
              if (env === "wsl" && distro) values.wsl_distro = distro;
              save(values);
            }}
            onKeyDown={activateOnKeys(() => {
              if (env === current) return;
              const values = { environment: env };
              if (env === "wsl" && distro) values.wsl_distro = distro;
              save(values);
            })}
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
    </div>
  );
}

// 检查更新：下载阶段显示真实进度条（phase 文案走 i18n），失败保留重试按钮
function UpdateSection() {
  const [status, setStatus] = useState({ text: t("settings.notChecked"), available: false });
  const [progress, setProgress] = useState(null); // { phase, percent|null }
  const [busy, setBusy] = useState(false);

  useEffect(() => window.api.onUpdateProgress(({ phase, percent }) => {
    setProgress({ phase, percent: percent == null ? null : percent });
  }), []);

  const phaseLabel = (phase) => {
    const key = UPDATE_PHASE_KEYS[phase];
    return key ? t(key) : phase;
  };
  const progressText = progress
    ? `${phaseLabel(progress.phase)}${progress.percent == null ? "" : ` ${progress.percent}%`}`
    : "";

  const check = async () => {
    setBusy(true);
    setProgress(null);
    setStatus({ text: t("state.checking"), available: false });
    try {
      const result = await window.api.updateCheck();
      if (!result || !result.ok) {
        setStatus({ text: `${t("settings.checkFailed")}: ${(result && result.error) || "unknown"}`, available: false });
      } else if (result.available) {
        setStatus({
          text: `${t("settings.updateAvailable")}: v${result.latest} (v${result.current})`,
          available: true,
        });
      } else {
        setStatus({ text: `${t("settings.upToDate")} (v${result.current})`, available: false });
      }
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setBusy(true);
    setStatus({ text: progressText || t("settings.preparingUpgrade"), available: true });
    try {
      const result = await window.api.updateInstall();
      if (!result || !result.ok) {
        setStatus({ text: `${t("settings.upgradeFailed")}: ${(result && result.error) || "unknown"}`, available: true });
        setProgress(null);
        setBusy(false);
      } else {
        setStatus({ text: t("settings.upgradedRestarting"), available: false });
      }
    } catch (err) {
      setStatus({ text: `${t("settings.upgradeFailed")}: ${err.message || err}`, available: true });
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div className="about-row"><span>{t("settings.update")}</span><strong>{status.text}</strong></div>
      {progress && (
        <div className="update-progress">
          <div className="update-progress-head">
            <span>{phaseLabel(progress.phase)}</span>
            <span>{progress.percent == null ? "" : `${progress.percent}%`}</span>
          </div>
          <div className="update-progress-track">
            <div
              className={`update-progress-fill${progress.percent == null ? " indeterminate" : ""}`}
              style={progress.percent == null ? undefined : { width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}
      <div className="settings-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="settings-save" disabled={busy} onClick={check}>{t("settings.checkUpdates")}</button>
        {status.available && (
          <button type="button" className="settings-save" disabled={busy} onClick={install}>
            {busy && progressText ? progressText : t("settings.downloadInstall")}
          </button>
        )}
      </div>
      <div className="settings-note">{t("settings.noTokenNeeded")}</div>
    </div>
  );
}

function AboutPanel({ settings, backend }) {
  return (
    <div className="panel" id="panel-about">
      <div className="panel-title">{t("settings.about")}</div>
      <div className="settings-card">
        <div className="about-row"><span>{t("settings.version")}</span><strong>{settings ? `v${settings.version}` : "—"}</strong></div>
        <div className="about-row"><span>{t("settings.dataSource")}</span><strong>{settings ? (settings.environment === "wsl" && settings.wsl_distro ? `WSL (${settings.wsl_distro})` : settings.environment) : "—"}</strong></div>
        <div className="about-row"><span>{t("settings.backend")}</span><strong className="about-path">{backend ? backend.engine : t("settings.backendNotRunning")}</strong></div>
        <UpdateSection />
      </div>
    </div>
  );
}

// --- 主组件：侧边栏（含返回按钮，分组导航） + 主体（居中列） ----------------------

const PANEL_GROUPS = [
  {
    labelKey: "settings.groupAppearance",
    items: [
      ["theme", "settings.theme"],
      ["language", "settings.language"],
      ["display", "settings.display"],
    ],
  },
  {
    labelKey: "settings.groupAccount",
    items: [
      ["membership", "settings.membership"],
      ["login", "settings.login"],
      ["apikeys", "settings.apikeys"],
    ],
  },
  {
    labelKey: "settings.groupEnvironment",
    items: [["environment", "settings.envTitle"]],
  },
  {
    labelKey: "settings.groupAbout",
    items: [["about", "settings.aboutItem"]],
  },
];

export default function SettingsPage({ lastPayload }) {
  const [activePanel, setActivePanel] = useState("theme");
  const [settings, setSettings] = useState(null);
  const [backend, setBackend] = useState(null);
  const [apiKeysReload, setApiKeysReload] = useState(0);
  useLang();

  const refreshSettings = useCallback(async () => {
    try {
      const result = await window.api.getSettings();
      if (result && result.ok) setSettings(result);
    } catch {}
    try { setBackend(await window.api.getBackendStatus()); } catch {}
  }, []);

  useEffect(() => { refreshSettings(); }, [refreshSettings]);

  const panel = (name) => `panel${activePanel === name ? "" : " hidden"}`;
  const envAvailable = (() => {
    const available = (settings && settings.available_environments) || [];
    const distros = (settings && settings.wsl_distros) || [];
    return available.length >= 2 || distros.length > 0;
  })();

  return (
    <div className="app-body">
      <div className="settings-sidebar main-settings-nav">
        <button type="button" className="settings-back" onClick={() => { window.location.hash = "#/dashboard"; }}>
          ← {t("nav.back")}
        </button>
        {PANEL_GROUPS.map((group) => {
          const items = group.items.filter(([key]) => key !== "environment" || envAvailable);
          if (items.length === 0) return null;
          return (
            <div className="side-group" key={group.labelKey}>
              <div className="side-group-label">{t(group.labelKey)}</div>
              {items.map(([key, labelKey]) => (
                <div
                  key={key}
                  className={`side-item${activePanel === key ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActivePanel(key)}
                  onKeyDown={activateOnKeys(() => setActivePanel(key))}
                >
                  {t(labelKey)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="settings-main page-scroll">
        <div className="settings-column">
          <div className={panel("display")}>
            <DisplayPanel lastPayload={lastPayload} />
          </div>
          <div className={panel("theme")}>
            <ThemePanel />
          </div>
          <div className={panel("language")}>
            <LanguagePanel />
          </div>
          <div className={panel("membership")}>
            <MembershipPanel
              settings={settings}
              lastPayload={lastPayload}
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
    </div>
  );
}
