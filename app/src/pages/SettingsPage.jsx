// 设置页（主窗口内，侧边栏 + 主体布局；侧边栏顶部带返回按钮）。
// Kimi Brand 12：240px 导航、640px 内容、Fills-F1 灰底卡片和线性返回图标。
// 行内反馈属于对应设置；窄窗口下控件换行，说明文字保持正常阅读宽度。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateOnKeys, fmtSpan,
  mergeDisplayOrder, writeDisplayOrder,
  readThemePreference, writeThemePreference, applyTheme,
} from "../utils.js";
import { t, useLang, setLang, getLang } from "../i18n.js";
import BrandIcon from "../components/BrandIcon.jsx";

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
    ? { text: t(autoRenew ? "settings.membershipRenewsIn" : "settings.membershipEndsIn").replace("{time}", fmtSpan(seconds)), ended: false }
    : { text: t("settings.membershipEndedAgo").replace("{time}", fmtSpan(-seconds)), ended: true };
}

// --- 行式布局基元（Kimi 设置风格） ------------------------------------------------

// 小组标签：卡片上方的小号弱化文字（如截图里的"自动操控"）
function GroupLabel({ children }) {
  return <div className="set-group-label">{children}</div>;
}

// 卡片行：可选图标 + 标题/描述（左） + 控件（右）
function SetRow({ icon, title, desc, note, stacked = false, children }) {
  return (
    <div className={`set-row${stacked ? " set-row-stacked" : ""}`}>
      {icon ? <span className="set-row-icon">{icon}</span> : null}
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {desc ? <div className="set-row-desc">{desc}</div> : null}
        {note ? <RowNote note={note} /> : null}
      </div>
      {children ? <div className="set-row-control">{children}</div> : null}
    </div>
  );
}

// 分段开关（brand 允许 pill 的唯一控件形态之一）
function Seg({ value, options, onChange, disabled = false }) {
  return (
    <div className={`seg${disabled ? " disabled" : ""}`} role="group">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          className={value === key ? "active" : ""}
          disabled={disabled}
          onClick={() => value !== key && onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// 设置行内反馈文字（保存中/已保存/失败）
function RowNote({ note }) {
  const text = note.key ? `${t(note.key)}${note.detail ? `: ${note.detail}` : ""}` : note.text;
  if (!text) return null;
  return <div className={note.cls} role="status" aria-live="polite">{text}</div>;
}

// --- 通用（外观/语言/每周起始/速率口径 四行一卡） ----------------------------------

function ThemeRow() {
  const [preference, setPreference] = useState(readThemePreference());
  const choose = (value) => {
    setPreference(value);
    writeThemePreference(value);
    applyTheme(value);
  };
  return (
    <SetRow title={t("settings.theme")} desc={t("settings.themeHint")}>
      <Seg
        value={preference}
        onChange={choose}
        options={[
          ["system", t("settings.themeSystem")],
          ["dark", t("settings.themeDark")],
          ["light", t("settings.themeLight")],
        ]}
      />
    </SetRow>
  );
}

function LanguageRow() {
  const [lang, setLangState] = useState(getLang());
  const choose = (value) => {
    setLang(value);
    setLangState(value);
  };
  return (
    <SetRow title={t("settings.language")} desc={t("settings.langHint")}>
      <Seg value={lang} onChange={choose} options={[["en", "English"], ["zh", "中文"]]} />
    </SetRow>
  );
}

function WeekStartRow({ settings }) {
  const [value, setValue] = useState("monday");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  useEffect(() => {
    setValue((settings && settings.week_start) || "monday");
  }, [settings && settings.week_start]);
  const save = async (next) => {
    const previous = value;
    setSaving(true);
    setValue(next);
    setNote({ cls: "settings-note", key: "state.saving" });
    try {
      const result = await window.api.setSettings({ week_start: next });
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setNote({ cls: "settings-note ok", key: "state.saved" });
    } catch (err) {
      setValue(previous);
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SetRow title={t("settings.week")} desc={t("settings.weekHint")} note={note}>
      <Seg
        value={value}
        disabled={saving || !settings}
        onChange={save}
        options={[["monday", t("settings.weekMonday")], ["sunday", t("settings.weekSunday")]]}
      />
    </SetRow>
  );
}

function SpeedModeRow({ settings }) {
  const [value, setValue] = useState("gen");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  useEffect(() => {
    setValue((settings && settings.speed_mode) || "gen");
  }, [settings && settings.speed_mode]);
  const save = async (next) => {
    const previous = value;
    setSaving(true);
    setValue(next);
    setNote({ cls: "settings-note", key: "state.saving" });
    try {
      const result = await window.api.setSettings({ speed_mode: next });
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setNote({ cls: "settings-note ok", key: "state.saved" });
    } catch (err) {
      setValue(previous);
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SetRow title={t("settings.speed")} desc={t("settings.speedHint")} note={note} stacked>
      <Seg
        value={value}
        disabled={saving || !settings}
        onChange={save}
        options={[["gen", t("settings.speedGen")], ["throughput", t("settings.speedThroughput")]]}
      />
    </SetRow>
  );
}

function GeneralCard({ settings }) {
  return (
    <section className="panel" id="panel-general">
      <GroupLabel>{t("settings.secGeneral")}</GroupLabel>
      <div className="set-card">
        <ThemeRow />
        <LanguageRow />
        <WeekStartRow settings={settings} />
        <SpeedModeRow settings={settings} />
      </div>
    </section>
  );
}

// --- 配额显示（勾选 + 拖拽排序） ----------------------------------------------------

function DisplayPanel({ lastPayload }) {
  const [knownProviders, setKnownProviders] = useState([]);
  const [selectedProviders, setSelectedProviders] = useState(new Set());
  // 展示顺序（v0.7.34）：拖拽手柄重排并持久化；用量分析配额区与看板同序
  const [order, setOrder] = useState([]);
  const [dragName, setDragName] = useState(null);
  const [dropName, setDropName] = useState(null);

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

  // 存储顺序过滤失效 provider、新 provider 附后；payload 刷新不打断未完成的拖拽
  useEffect(() => {
    if (!dragName) setOrder(mergeDisplayOrder(knownProviders));
  }, [knownProviders.join("|")]);

  // 原生拖拽期间不派发 mouseup；手柄按下未拖动即松开时在此复位
  useEffect(() => {
    const clear = () => setDragName(null);
    window.addEventListener("mouseup", clear);
    return () => window.removeEventListener("mouseup", clear);
  }, []);

  const dropRow = (target) => {
    const source = dragName;
    setDropName(null);
    setDragName(null);
    if (!source || source === target) return;
    setOrder((prev) => {
      const next = prev.filter((n) => n !== source);
      const at = next.indexOf(target);
      next.splice(at >= 0 ? at : next.length, 0, source);
      writeDisplayOrder(next);
      return next;
    });
  };

  const persist = (next) => {
    try { localStorage.setItem(DISPLAY_SELECTION_KEY, JSON.stringify([...next])); } catch {}
  };
  const toggle = (name) => setSelectedProviders((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    persist(next);
    return next;
  });
  const allSelected = knownProviders.length > 0 && selectedProviders.size === knownProviders.length;

  return (
    <div className="panel" id="panel-display">
      <GroupLabel>{t("settings.displayTitle")}</GroupLabel>
      <div className="set-card">
        <div className="set-row set-row-desc-only">
          <div className="set-row-text">
            <div className="set-row-desc">{t("settings.displayHint")} {t("settings.displayOrderHint")}</div>
          </div>
        </div>
        <div
          className="display-list-item"
          role="button"
          tabIndex={0}
          onClick={() => {
            const next = allSelected ? new Set() : new Set(knownProviders);
            setSelectedProviders(next);
            persist(next);
          }}
          onKeyDown={activateOnKeys(() => {
            const next = allSelected ? new Set() : new Set(knownProviders);
            setSelectedProviders(next);
            persist(next);
          })}
        >
          <span className="display-drag-spacer" />
          <span className={`cb${allSelected ? " on" : selectedProviders.size > 0 ? " partial" : ""}`} />
          {t("settings.all")}
        </div>
        {order.map((name) => (
          <div
            key={name}
            className={`display-list-item${dragName === name ? " dragging" : ""}${dropName === name && dragName && dragName !== name ? " drop-target" : ""}`}
            role="button"
            tabIndex={0}
            draggable={dragName === name}
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", name);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => { setDragName(null); setDropName(null); }}
            onDragOver={(event) => {
              event.preventDefault();
              setDropName((prev) => (prev === name ? prev : name));
            }}
            onDrop={() => dropRow(name)}
            onClick={() => toggle(name)}
            onKeyDown={activateOnKeys(() => toggle(name))}
          >
            <span
              className="card-drag display-drag"
              title={t("settings.displayOrderHint")}
              onMouseDown={() => setDragName(name)}
              onClick={(event) => event.stopPropagation()}
            >⠿</span>
            <span className={`cb${selectedProviders.has(name) ? " on" : ""}`} />
            <BrandIcon of={name} size={14} />
            {name}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- 账户：会员 / 登录 / API Keys ---------------------------------------------------

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
  }, [settings && settings.membership]);

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
    setNote({ cls: "settings-note", key: "state.saving" });
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
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setNote({ cls: "settings-note ok", key: "state.saved" });
      onSaved(result);
      try { window.api.refresh(); } catch {}
    } catch (err) {
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="panel" id="panel-membership">
      <GroupLabel>{t("settings.membership")}</GroupLabel>
      <div className="set-card">
        <div className="set-row set-row-desc-only">
          <div className="set-row-text">
            <div className="set-row-desc">{t("settings.membershipHint")}</div>
          </div>
        </div>
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
            <div className="set-row membership-set-row" key={row.key}>
              <span className="set-row-icon"><BrandIcon of={row.label} size={16} /></span>
              <div className="set-row-text">
                <div className="set-row-title">
                  {row.label}
                  {row.auto && <span className="membership-auto">{t("settings.membershipAuto")}</span>}
                </div>
                {stateText ? <div className={`set-row-desc membership-state${stateCls}`}>{stateText}</div> : null}
              </div>
              <div className="set-row-control membership-inputs">
                <input
                  type="datetime-local" className="membership-date" value={row.date}
                  aria-label={`${row.label} · ${t("settings.membershipDate")}`}
                  disabled={row.auto || saving}
                  onChange={(event) => setRows((prev) => prev.map((r) =>
                    r.key === row.key ? { ...r, date: event.target.value } : r))}
                />
                <input
                  type="number" className="membership-months" min="1" max="120" step="1"
                  placeholder="1" value={row.months}
                  aria-label={`${row.label} · ${t("settings.membershipMonths")}`}
                  disabled={row.auto || saving}
                  onChange={(event) => setRows((prev) => prev.map((r) =>
                    r.key === row.key ? { ...r, months: event.target.value } : r))}
                />
                <span className="membership-unit">{t("settings.membershipMonths")}</span>
              </div>
            </div>
          );
        })}
        <div className="set-row set-row-foot">
          <RowNote note={note} />
          <div className="set-row-control">
            <button type="button" className="settings-save" disabled={saving || !settings} onClick={save}>{t(saving ? "state.saving" : "state.save")}</button>
          </div>
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
    setNote({ cls: "settings-note", key: "settings.startingLogin" });
    try {
      const environment = (currentSettings && currentSettings.environment)
        || (lastPayload && lastPayload.data && lastPayload.data.environment);
      const result = await window.api.loginAgent(agent, environment);
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setNote({ cls: "settings-note ok", key: "settings.loginStarted" });
    } catch (err) {
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };
  const agents = [
    ["kimi", "Kimi Code"],
    ["codex", "OpenAI Codex"],
  ];
  return (
    <div className="panel" id="panel-login">
      <GroupLabel>{t("settings.loginTitle")}</GroupLabel>
      <div className="set-card">
        {agents.map(([agent, name]) => (
          <div className="set-row" key={agent}>
            <span className="set-row-icon"><BrandIcon of={name} size={16} /></span>
            <div className="set-row-text">
              <div className="set-row-title">{name}</div>
              <div className="set-row-desc">{t("settings.loginMethod")}</div>
            </div>
            <div className="set-row-control">
              <button type="button" className="login-btn" disabled={busy} onClick={() => login(agent)}>{t("settings.loginBtn")}</button>
            </div>
          </div>
        ))}
        <div className="set-row set-row-foot"><RowNote note={note} /></div>
      </div>
    </div>
  );
}

function ApiKeysPanel({ reloadKey }) {
  const inputs = { deepseek: useRef(null), glm: useRef(null) };
  const [states, setStates] = useState({});
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const [saving, setSaving] = useState(false);

  const showStatus = (provider, info = {}) => {
    setStates((prev) => ({ ...prev, [provider]: info }));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.getApiKeyStatus();
        if (cancelled) return;
        if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
        for (const provider of Object.keys(inputs)) {
          showStatus(provider, (result.status || {})[provider]);
        }
      } catch (err) {
        if (!cancelled) setNote({ cls: "settings-note error", key: "settings.keyStatusFailed", detail: String(err.message || err) });
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
      setNote({ cls: "settings-note error", key: "settings.needOneKey" });
      return;
    }
    setSaving(true);
    setNote({ cls: "settings-note", key: "state.saving" });
    try {
      const result = await window.api.saveApiKeys(values);
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      for (const provider of Object.keys(inputs)) {
        showStatus(provider, (result.status || {})[provider]);
        if (inputs[provider].current) inputs[provider].current.value = "";
      }
      setNote({ cls: "settings-note ok", key: "state.saved" });
    } catch (err) {
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    } finally {
      setSaving(false);
    }
  };

  const providers = [
    ["deepseek", "DeepSeek"],
    ["glm", "GLM / BigModel"],
  ];
  return (
    <div className="panel" id="panel-apikeys">
      <GroupLabel>{t("settings.apikeys")}</GroupLabel>
      <div className="set-card">
        <div className="set-row set-row-desc-only">
          <div className="set-row-text">
            <div className="set-row-desc">{t("settings.apiKeysHint")}</div>
          </div>
        </div>
        {providers.map(([provider, name]) => {
          const info = states[provider];
          const configured = info && info.configured;
          const invalid = info && info.source === "invalid";
          const label = !info ? t("state.checking") : configured
            ? t("settings.configured").replace("{src}", info.source || "local")
            : t(invalid ? "settings.invalidCred" : "settings.notConfigured");
          const placeholder = t(configured ? "settings.keepKeyPh" : invalid ? "settings.replaceKeyPh" : "settings.enterKeyPh");
          return (
          <div className="set-row" key={provider}>
            <span className="set-row-icon"><BrandIcon of={provider} size={16} /></span>
            <div className="set-row-text">
              <div className="set-row-title">{name}</div>
              <div className={`set-row-desc key-state${configured ? " configured" : invalid ? " invalid" : ""}`}>{label}</div>
            </div>
            <div className="set-row-control">
              <input
                ref={inputs[provider]} className="key-input key-input-inline" type="password"
                aria-label={`${name} API key`} disabled={saving}
                autoComplete="off" spellCheck={false} placeholder={placeholder}
              />
            </div>
          </div>
          );
        })}
        <div className="set-row set-row-foot">
          <RowNote note={note} />
          <div className="set-row-control">
            <button type="button" className="settings-save" disabled={saving} onClick={save}>{t(saving ? "state.saving" : "state.save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- 环境 ---------------------------------------------------------------------------

function EnvironmentPanel({ settings, onSaved }) {
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const available = (settings && settings.available_environments) || [];
  const wslDistros = (settings && settings.wsl_distros) || [];
  const current = (settings && settings.environment) || "";
  const [distro, setDistro] = useState((settings && settings.wsl_distro) || "");
  useEffect(() => {
    // 以设置载荷的 wsl_distro 为准同步（挂载时 settings 尚为 null，初值是
    // 空串——若只按“不在列表则取首项”回落，重开页面会把已保存的发行版
    // 显示回第一项，看起来像“选不上”）。配置值无效时才回落首项。
    const configured = (settings && settings.wsl_distro) || "";
    setDistro(wslDistros.includes(configured) ? configured : (wslDistros[0] || ""));
  }, [wslDistros.join("|"), (settings && settings.wsl_distro) || ""]);
  if (available.length < 2 && wslDistros.length === 0) return null;
  const save = async (values) => {
    setNote({ cls: "settings-note", key: "state.saving" });
    try {
      const result = await window.api.setSettings(values);
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setNote({ cls: "settings-note ok", key: "state.saved" });
      onSaved(result.settings || {});
    } catch (err) {
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    }
  };
  return (
    <div className="panel" id="panel-environment">
      <GroupLabel>{t("settings.envTitle")}</GroupLabel>
      <div className="set-card">
        <div className="set-row set-row-desc-only">
          <div className="set-row-text">
            <div className="set-row-desc">{t("settings.envHint")}</div>
          </div>
        </div>
        <SetRow title={t("settings.envSource")}>
          <Seg
            value={current}
            onChange={(env) => {
              if (env === current) return;
              const values = { environment: env };
              if (env === "wsl" && distro) values.wsl_distro = distro;
              save(values);
            }}
            options={available.map((env) => [env, env === "wsl" ? "WSL" : t("settings.envNative")])}
          />
        </SetRow>
        {current === "wsl" && wslDistros.length ? (
          <SetRow title={t("settings.wslDistro")}>
            <select
              id="wsl-distro" className="wsl-distro-select" value={distro}
              onChange={(event) => {
                setDistro(event.target.value);
                if (event.target.value) save({ wsl_distro: event.target.value });
              }}
            >
              {wslDistros.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </SetRow>
        ) : null}
        <div className="set-row set-row-foot"><RowNote note={note} /></div>
      </div>
    </div>
  );
}

// --- 关于 ---------------------------------------------------------------------------

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
    } catch (err) {
      setStatus({ text: `${t("settings.checkFailed")}: ${err.message || err}`, available: false });
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
    <>
      <div className="set-row">
        <div className="set-row-text">
          <div className="set-row-title">{t("settings.update")}</div>
          <div className="set-row-desc">{status.text}</div>
        </div>
        <div className="set-row-control settings-update-btns">
          <button type="button" className="login-btn" disabled={busy} onClick={check}>{t("settings.checkUpdates")}</button>
          {status.available && (
            <button type="button" className="settings-save" disabled={busy} onClick={install}>
              {busy && progressText ? progressText : t("settings.downloadInstall")}
            </button>
          )}
        </div>
      </div>
      {progress && (
        <div className="set-row set-row-desc-only">
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
        </div>
      )}
    </>
  );
}

function AboutPanel({ settings, backend }) {
  const rows = [
    [t("settings.version"), settings ? `v${settings.version}` : "—"],
    [t("settings.dataSource"), settings ? (settings.environment === "wsl" && settings.wsl_distro ? `WSL (${settings.wsl_distro})` : settings.environment) : "—"],
    [t("settings.backend"), backend ? backend.engine : t("settings.backendNotRunning")],
  ];
  return (
    <div className="panel" id="panel-about">
      <div className="set-card">
        {rows.map(([label, value]) => (
          <div className="set-row" key={label}>
            <div className="set-row-text">
              <div className="set-row-title">{label}</div>
            </div>
            <div className="set-row-control about-value">{value}</div>
          </div>
        ))}
        <UpdateSection />
      </div>
    </div>
  );
}

// --- 主组件：侧边栏（含返回按钮，图标导航） + 主体（分组卡片） -------------------------

const NAV_ICONS = {
  appearance: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </svg>
  ),
  account: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="5.2" r="2.6" />
      <path d="M2.8 13.6c.7-2.6 2.8-4 5.2-4s4.5 1.4 5.2 4" />
    </svg>
  ),
  environment: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.6" width="12" height="4.6" rx="1.2" />
      <rect x="2" y="8.8" width="12" height="4.6" rx="1.2" />
      <path d="M4.6 4.9h.01M4.6 11.1h.01" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.2v3.4M8 4.9h.01" />
    </svg>
  ),
};

const PANEL_GROUPS = [
  {
    key: "appearance",
    labelKey: "settings.groupAppearance",
    panels: ["general", "display"],
  },
  {
    key: "account",
    labelKey: "settings.groupAccount",
    panels: ["membership", "login", "apikeys"],
  },
  {
    key: "environment",
    labelKey: "settings.groupEnvironment",
    panels: ["environment"],
  },
  {
    key: "about",
    labelKey: "settings.groupAbout",
    panels: ["about"],
  },
];

export default function SettingsPage({ lastPayload }) {
  const [activeGroup, setActiveGroup] = useState("appearance");
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

  const groupClass = (key) => `panel-group${activeGroup === key ? "" : " hidden"}`;
  const envAvailable = (() => {
    const available = (settings && settings.available_environments) || [];
    const distros = (settings && settings.wsl_distros) || [];
    return available.length >= 2 || distros.length > 0;
  })();
  const activeLabel = (PANEL_GROUPS.find((g) => g.key === activeGroup) || PANEL_GROUPS[0]).labelKey;

  return (
    <div className="app-body settings-body">
      <nav className="settings-sidebar main-settings-nav" aria-label={t("tip.settings")}>
        <button type="button" className="settings-back" onClick={() => { window.location.hash = "#/dashboard"; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m10 5-7 7 7 7M3 12h18" />
          </svg>
          {t("nav.back")}
        </button>
        {PANEL_GROUPS.map((group) => {
          if (group.key === "environment" && !envAvailable) return null;
          return (
            <button
              type="button"
              key={group.key}
              className={`side-item${activeGroup === group.key ? " active" : ""}`}
              aria-current={activeGroup === group.key ? "page" : undefined}
              onClick={() => setActiveGroup(group.key)}
            >
              <span className="side-icon">{NAV_ICONS[group.key]}</span>
              {t(group.labelKey)}
            </button>
          );
        })}
      </nav>
      <div className="settings-main page-scroll">
        <div className="settings-column">
          <div className="settings-content-title">{t(activeLabel)}</div>
          <div className={groupClass("appearance")}>
            <GeneralCard settings={settings} />
            <DisplayPanel lastPayload={lastPayload} />
          </div>
          <div className={groupClass("account")}>
            <MembershipPanel
              settings={settings}
              lastPayload={lastPayload}
              onSaved={(result) => {
                setSettings((prev) => ({
                  ...(prev || {}), ...result.settings,
                  ...(result.membership ? { membership: result.membership } : {}),
                }));
              }}
            />
            <LoginPanel currentSettings={settings} lastPayload={lastPayload} />
            <ApiKeysPanel reloadKey={apiKeysReload} />
          </div>
          <div className={groupClass("environment")}>
            <EnvironmentPanel
              settings={settings}
              onSaved={(next) => {
                setSettings((prev) => ({ ...(prev || {}), ...next }));
                setApiKeysReload((n) => n + 1);
              }}
            />
          </div>
          <div className={groupClass("about")}>
            <AboutPanel settings={settings} backend={backend} />
          </div>
        </div>
      </div>
    </div>
  );
}
