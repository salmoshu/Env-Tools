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
import { showToast } from "../toast.jsx";
import { useUpdateState, setUpdateBusy, setUpdateProgress, setUpdateStatus } from "../updateState.js";
import BrandIcon from "../components/BrandIcon.jsx";
import Select from "../components/Select.jsx";
import {
  AGENT_ACCOUNTS, agentMembershipKey, useAgentAccounts,
} from "../agentAccounts.js";

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

// 设置行反馈：结果性消息（ok/error）改为顶部向下滑出的框提醒；
// 中性的过程状态（保存中）保留行内文字，避免每次保存弹两条
function RowNote({ note }) {
  const text = note.key ? `${t(note.key)}${note.detail ? `: ${note.detail}` : ""}` : note.text;
  useEffect(() => {
    if (!text) return;
    if (/ok$/.test(note.cls)) showToast(text, "ok");
    else if (/error$/.test(note.cls)) showToast(text, "error", 6000);
  }, [text, note.cls]);
  if (!text || /(ok|error)$/.test(note.cls)) return null;
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
    const names = [...new Set((lastPayload.data.accounts || []).map((a) => a.provider))];
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

  const toggleAll = () => {
    const next = allSelected ? new Set() : new Set(knownProviders);
    setSelectedProviders(next);
    persist(next);
  };

  return (
    <div className="panel" id="panel-display">
      <GroupLabel>{t("settings.displayTitle")}</GroupLabel>
      <div className="set-card">
        <div className="set-row set-row-desc-only">
          <div className="set-row-text">
            <div className="set-row-desc">{t("settings.displayHint")} {t("settings.displayOrderHint")}</div>
          </div>
        </div>
        {/* provider 卡片网格（v0.7.43）：首张「全部」+ 各 provider 卡；
            勾选状态由卡片点击切换，拖拽手柄悬停浮现 */}
        <div className="display-cards">
          <div
            className={`display-card${allSelected ? " on" : ""}`}
            role="button"
            tabIndex={0}
            onClick={toggleAll}
            onKeyDown={activateOnKeys(toggleAll)}
          >
            <span className="display-drag-spacer" />
            <span className="display-card-name">{t("settings.all")}</span>
            <span className={`cb${allSelected ? " on" : selectedProviders.size > 0 ? " partial" : ""}`} />
          </div>
          {order.map((name) => {
            const on = selectedProviders.has(name);
            return (
              <div
                key={name}
                className={`display-card${on ? " on" : ""}${dragName === name ? " dragging" : ""}${dropName === name && dragName && dragName !== name ? " drop-target" : ""}`}
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
                <BrandIcon of={name} size={14} />
                <span className="display-card-name">{name}</span>
                <span className={`cb${on ? " on" : ""}`} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- 智能体：厂商 / 会员 / 登录 / API Keys ------------------------------------------

// 会员面板：每行三态 —— 手动配置（可编辑，回填 purchased_at/duration_months）/
// 自动获取（provider 订阅接口给出 ends_at，禁用输入并标注，不随保存提交）/
// 可编辑空行。保存后触发 window.api.refresh() 让看板立即刷新。
function MembershipPanel({ settings, lastPayload, onSaved, providers, id }) {
  const [rows, setRows] = useState([]);
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const [saving, setSaving] = useState(false);
  const providerSignature = providers.map((definition) => definition.join(":")).join("|");

  // 可编辑字段只在 settings 或账号列表变化时重建，避免用量推送冲刷输入中的内容
  useEffect(() => {
    const membership = (settings && settings.membership) || {};
    setRows(providers.map(([key, label, accountId, providerName]) => {
      const entry = membership[key];
      const manual = Boolean(entry && !entry.error && entry.purchased_at);
      return {
        key,
        label,
        accountId,
        provider: providerName || label,
        manual,
        date: manual ? toLocalInputValue(entry.purchased_at) : "",
        months: manual && entry.duration_months ? String(entry.duration_months) : "",
      };
    }));
  }, [settings && settings.membership, providerSignature]);

  const membership = (settings && settings.membership) || {};
  const accounts = (lastPayload && lastPayload.data && lastPayload.data.accounts) || [];

  // 自动获取状态在渲染时从 lastPayload 派生（随用量推送实时更新）
  const rowsWithAuto = rows.map((row) => {
    if (row.manual) return { ...row, auto: false, autoEndsAt: null, autoDurationMonths: "", autoError: null };
    const account = accounts.find((item) => item.provider === row.provider
      && (!row.accountId || (item.account_id || "default") === row.accountId));
    const accountMembership = account && account.membership;
    if (accountMembership && accountMembership.error) {
      return { ...row, auto: false, autoEndsAt: null, autoDurationMonths: "", autoError: accountMembership.error };
    }
    const endsAt = accountMembership && accountMembership.ends_at;
    return {
      ...row,
      auto: Boolean(endsAt),
      autoEndsAt: endsAt || null,
      autoDurationMonths: accountMembership && accountMembership.duration_months
        ? String(accountMembership.duration_months) : "",
      autoError: null,
    };
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
    <div className="panel" id={id}>
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
              <span className="set-row-icon"><BrandIcon of={row.provider} size={16} /></span>
              <div className="set-row-text">
                <div className="set-row-title">
                  {row.label}
                  {row.auto && <span className="membership-auto">{t("settings.membershipAuto")}</span>}
                </div>
                {stateText ? <div className={`set-row-desc membership-state${stateCls}`}>{stateText}</div> : null}
              </div>
              <div className="set-row-control membership-inputs">
                <input
                  type="datetime-local" className="membership-date"
                  value={row.auto ? toLocalInputValue(row.autoEndsAt) : row.date}
                  aria-label={`${row.label} · ${t("settings.membershipDate")}`}
                  disabled={row.auto || saving}
                  onChange={(event) => setRows((prev) => prev.map((r) =>
                    r.key === row.key ? { ...r, date: event.target.value } : r))}
                />
                <input
                  type="number" className="membership-months" min="1" max="120" step="1"
                  placeholder="1" value={row.auto ? row.autoDurationMonths || "" : row.months}
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

function accountApiKeyStatus(account) {
  if (account.source === "invalid") {
    return { text: t("settings.invalidCred"), className: " invalid", placeholder: t("settings.replaceKeyPh") };
  }
  if (account.configured) {
    return {
      text: account.source
        ? t("settings.configured").replace("{src}", account.source)
        : t("settings.accountApiKeyConfigured"),
      className: " configured",
      placeholder: t("settings.keepKeyPh"),
    };
  }
  return { text: t("settings.accountApiKeyMissing"), className: "", placeholder: t("settings.enterKeyPh") };
}

function AccountApiKeysPanel({ provider, accounts, reload }) {
  const definition = AGENT_ACCOUNTS[provider];
  const [values, setValues] = useState({});
  const [savingId, setSavingId] = useState("");
  const [note, setNote] = useState({ cls: "settings-note", text: "" });

  const save = async (accountId) => {
    const apiKey = String(values[accountId] || "").trim();
    if (!apiKey) {
      setNote({ cls: "settings-note error", key: "settings.needOneKey" });
      return;
    }
    setSavingId(accountId);
    setNote({ cls: "settings-note", key: "state.saving" });
    try {
      const result = await window.api.saveApiKeys({ provider, account_id: accountId, api_key: apiKey });
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setValues((previous) => ({ ...previous, [accountId]: "" }));
      await reload().catch(() => {});
      try { window.api.refresh(); } catch {}
      setNote({ cls: "settings-note ok", key: "state.saved" });
    } catch (err) {
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    } finally {
      setSavingId("");
    }
  };

  return (
    <div className="panel" id={`panel-apikeys-${provider}`}>
      <GroupLabel>{t("settings.apikeys")}</GroupLabel>
      <div className="set-card">
        <div className="set-row set-row-desc-only">
          <div className="set-row-text">
            <div className="set-row-desc">{t("settings.apiKeysHint")}</div>
          </div>
        </div>
        {accounts.map((account) => (
          <div className="set-row agent-api-key-row" data-account-id={account.id} key={account.id}>
            <span className="set-row-icon"><BrandIcon of={definition.quotaProvider} size={16} /></span>
            <div className="set-row-text">
              <div className="set-row-title">{account.label}</div>
              <div className={`set-row-desc key-state${accountApiKeyStatus(account).className}`}>
                {accountApiKeyStatus(account).text}
              </div>
            </div>
            <div className="set-row-control agent-api-key-control">
              <input
                className="key-input key-input-inline"
                type="password"
                aria-label={`${account.label} API key`}
                disabled={Boolean(savingId)}
                autoComplete="off"
                spellCheck={false}
                value={values[account.id] || ""}
                placeholder={accountApiKeyStatus(account).placeholder}
                onChange={(event) => setValues((previous) => ({ ...previous, [account.id]: event.target.value }))}
                onKeyDown={(event) => { if (event.key === "Enter") save(account.id); }}
              />
              <button
                type="button"
                className="settings-save"
                disabled={Boolean(savingId) || !String(values[account.id] || "").trim()}
                onClick={() => save(account.id)}
              >{t(savingId === account.id ? "state.saving" : "state.save")}</button>
            </div>
          </div>
        ))}
        <div className="set-row set-row-foot"><RowNote note={note} /></div>
      </div>
    </div>
  );
}

function AgentAccountsPanel({ provider, settings, lastPayload, onSaved }) {
  const definition = AGENT_ACCOUNTS[provider];
  const [label, setLabel] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [note, setNote] = useState({ cls: "settings-note", text: "" });
  const [pending, setPending] = useState(false);
  const quotaAccounts = (lastPayload && lastPayload.data && lastPayload.data.accounts) || [];
  const {
    registry,
    activeId,
    selectAccount,
    updateAccounts,
    reload,
    error,
    switching,
    defaultRemoved,
    launcherInstalled,
    ready,
  } = useAgentAccounts(provider, quotaAccounts);
  const busy = pending || switching;
  useEffect(() => {
    if (!window.api.onLoginAgentUpdate) return undefined;
    return window.api.onLoginAgentUpdate((payload) => {
      if (!payload || payload.agent !== provider) return;
      if (payload.account_id && !registry.some((account) => account.id === payload.account_id)) return;
      setPending(false);
      if (payload.ok) {
        setNote({ cls: "settings-note ok", key: "settings.loginCompleted" });
        reload().catch(() => {});
        try { window.api.refresh(); } catch {}
      } else {
        setNote({ cls: "settings-note error", key: "settings.loginFailed", detail: payload.error || t("state.unknownError") });
      }
    });
  }, [provider, registry, reload]);
  const visibleNote = note.key || note.text ? note
    : error ? { cls: "settings-note error", text: error } : note;
  const hasDefault = registry.some((account) => account.id === "default");
  const showRestore = defaultRemoved || (ready && !hasDefault);

  const update = async (values) => {
    setPending(true);
    setNote({ cls: "settings-note", key: "state.saving" });
    try {
      const result = await updateAccounts(values);
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setNote({ cls: "settings-note ok", key: "state.saved" });
      return result;
    } catch (err) {
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
      return null;
    } finally {
      setPending(false);
    }
  };

  const add = async () => {
    const value = label.trim();
    if (!value) {
      setNote({ cls: "settings-note error", key: "settings.accountNeedLabel" });
      return;
    }
    const result = await update({ action: "add", label: value });
    if (result) setLabel("");
  };

  const activate = async (accountId) => {
    setNote({ cls: "settings-note", key: "state.saving" });
    const result = await selectAccount(accountId);
    const ok = Boolean(result && result.ok !== false);
    const failed = result && result.account_sync && result.account_sync.failed || [];
    setNote(failed.length
      ? { cls: "settings-note error", key: "settings.accountSyncPartial", detail: failed.map((item) => item.scope).join(", ") }
      : ok
        ? { cls: "settings-note ok", key: "settings.accountActivated" }
        : { cls: "settings-note error", key: "settings.accountSwitchFailed" });
  };

  const rename = async (accountId) => {
    const value = editingLabel.trim();
    if (!value) {
      setNote({ cls: "settings-note error", key: "settings.accountNeedLabel" });
      return;
    }
    const result = await update({ action: "rename", id: accountId, label: value });
    if (result) setEditingId("");
  };

  const login = async (accountId) => {
    setPending(true);
    setNote({ cls: "settings-note", key: "settings.startingLogin" });
    try {
      const environment = (settings && settings.environment)
        || (lastPayload && lastPayload.data && lastPayload.data.environment);
      const result = await window.api.loginAgent(provider, environment, accountId);
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      setNote({ cls: "settings-note ok", key: "settings.loginStarted" });
      try { window.api.refresh(); } catch {}
    } catch (err) {
      setNote({ cls: "settings-note error", key: "state.saveFailed", detail: String(err.message || err) });
    } finally {
      setPending(false);
    }
  };

  const membershipProviders = registry.map((account) => [
    agentMembershipKey(provider, account),
    account.label,
    account.id,
    definition.quotaProvider,
  ]);

  return (
    <AgentVendor id={`panel-agent-${provider}`} title={definition.label}>
      <div className="panel" id={`panel-${provider}-accounts`}>
        <GroupLabel>{t("settings.accountsTitle")}</GroupLabel>
        <div className="set-card">
          <div className="set-row set-row-desc-only">
            <div className="set-row-text">
              <div className="set-row-desc">
                {t("settings.accountsHint").replace("{provider}", definition.label)} {t("settings.removeAccountHint")}
                {definition.credential === "login" ? ` ${t("settings.profileAccountsHint")}` : ""}
              </div>
              {provider === "codex" ? (
                <div className={`set-row-desc key-state${launcherInstalled ? " configured" : ""}`}>
                  {t(launcherInstalled ? "settings.codexLauncherReady" : "settings.codexLauncherNeeded")}
                </div>
              ) : null}
            </div>
            {showRestore ? (
              <div className="set-row-control">
                <button type="button" className="login-btn" disabled={busy} onClick={() => update({ action: "restore-default" })}>
                  {t("settings.accountRestoreDefault")}
                </button>
              </div>
            ) : null}
          </div>
          {ready && registry.length === 0 ? (
            <div className="set-row set-row-desc-only">
              <div className="set-row-text"><div className="set-row-desc">{t("settings.accountsEmpty")}</div></div>
            </div>
          ) : null}
          {registry.map((account) => {
            const editing = editingId === account.id;
            return (
              <div className="set-row agent-account-row" data-account-id={account.id} key={account.id}>
                <span className="set-row-icon"><BrandIcon of={definition.quotaProvider} size={16} /></span>
                <div className="set-row-text">
                  {editing ? (
                    <input
                      className="key-input agent-account-rename-input"
                      value={editingLabel}
                      disabled={busy}
                      aria-label={t("settings.accountLabelPh")}
                      onChange={(event) => setEditingLabel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") rename(account.id);
                        if (event.key === "Escape") setEditingId("");
                      }}
                    />
                  ) : (
                    <div className="set-row-title">
                      {account.label}
                      {account.id === activeId ? <span className="membership-auto">{t("settings.accountActive")}</span> : null}
                    </div>
                  )}
                  <div className={`set-row-desc key-state${definition.credential === "login"
                    ? account.configured ? " configured" : ""
                    : accountApiKeyStatus(account).className}`}
                  >
                    {definition.credential === "login"
                      ? t(account.configured ? "settings.accountConfigured" : "settings.accountNotConfigured")
                      : accountApiKeyStatus(account).text}
                  </div>
                </div>
                <div className={`set-row-control agent-account-actions${provider === "codex" ? " codex-account-actions" : ""}`}>
                  {editing ? (
                    <>
                      <button type="button" className="settings-save" disabled={busy || !editingLabel.trim()} onClick={() => rename(account.id)}>{t("state.save")}</button>
                      <button type="button" className="login-btn" disabled={busy} onClick={() => setEditingId("")}>{t("upgrade.cancel")}</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="login-btn" disabled={busy || account.id === activeId} onClick={() => activate(account.id)}>
                        {t(account.id === activeId ? "settings.accountActive" : "settings.accountUse")}
                      </button>
                      {definition.credential === "login" ? (
                        <button type="button" className="login-btn" disabled={busy} onClick={() => login(account.id)}>{t("settings.loginBtn")}</button>
                      ) : null}
                      <button
                        type="button"
                        className="login-btn agent-account-rename"
                        disabled={busy}
                        onClick={() => { setEditingId(account.id); setEditingLabel(account.label); }}
                      >{t("settings.accountRename")}</button>
                      <button
                        type="button"
                        className="settings-delete agent-account-remove"
                        disabled={busy}
                        onClick={() => update({ action: "remove", id: account.id })}
                      >{t("settings.accountRemove")}</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <div className={`set-row agent-account-add${provider === "codex" ? " codex-account-add" : ""}`}>
            <div className="set-row-text">
              <div className="set-row-title">{t("settings.accountAdd")}</div>
            </div>
            <div className="set-row-control">
              <input
                className={`key-input agent-account-input${provider === "codex" ? " codex-account-input" : ""}`}
                value={label}
                disabled={busy}
                placeholder={t("settings.accountLabelPh")}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") add(); }}
              />
              <button type="button" className="settings-save" disabled={busy || !label.trim()} onClick={add}>
                {t("tools.add")}
              </button>
            </div>
          </div>
          <div className="set-row set-row-foot"><RowNote note={visibleNote} /></div>
        </div>
      </div>
      {definition.credential === "apiKey" && registry.length ? (
        <AccountApiKeysPanel provider={provider} accounts={registry} reload={reload} />
      ) : null}
      {registry.length ? (
        <MembershipPanel
          id={`panel-membership-${provider}`}
          settings={settings}
          lastPayload={lastPayload}
          onSaved={onSaved}
          providers={membershipProviders}
        />
      ) : null}
    </AgentVendor>
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
            <Select
              value={distro}
              ariaLabel={t("settings.wslDistro")}
              onChange={(value) => {
                setDistro(value);
                if (value) save({ wsl_distro: value });
              }}
              options={wslDistros.map((name) => [name, name])}
            />
          </SetRow>
        ) : null}
        <div className="set-row set-row-foot"><RowNote note={note} /></div>
      </div>
    </div>
  );
}

// --- 关于 ---------------------------------------------------------------------------

// 检查更新：下载阶段显示真实进度条（phase 文案走 i18n），失败保留重试按钮。
// 状态存全局 updateState：退出设置页再回来，下载中/完成/失败状态都还在。
function UpdateSection() {
  const { busy, progress, status } = useUpdateState();
  const statusText = status.text || t("settings.notChecked");

  const phaseLabel = (phase) => {
    const key = UPDATE_PHASE_KEYS[phase];
    return key ? t(key) : phase;
  };
  const progressText = progress
    ? `${phaseLabel(progress.phase)}${progress.percent == null ? "" : ` ${progress.percent}%`}`
    : "";

  const check = async () => {
    setUpdateBusy(true);
    setUpdateProgress(null);
    setUpdateStatus({ text: t("state.checking"), available: false });
    try {
      const result = await window.api.updateCheck();
      if (!result || !result.ok) {
        setUpdateStatus({ text: `${t("settings.checkFailed")}: ${(result && result.error) || "unknown"}`, available: false });
      } else if (result.available) {
        setUpdateStatus({
          text: `${t("settings.updateAvailable")}: v${result.latest} (v${result.current})`,
          available: true,
        });
      } else {
        setUpdateStatus({ text: `${t("settings.upToDate")} (v${result.current})`, available: false });
      }
    } catch (err) {
      setUpdateStatus({ text: `${t("settings.checkFailed")}: ${err.message || err}`, available: false });
    } finally {
      setUpdateBusy(false);
    }
  };

  const install = async () => {
    setUpdateBusy(true);
    setUpdateStatus({ text: progressText || t("settings.preparingUpgrade"), available: true });
    try {
      const result = await window.api.updateInstall();
      if (!result || !result.ok) {
        setUpdateStatus({ text: `${t("settings.upgradeFailed")}: ${(result && result.error) || "unknown"}`, available: true });
        setUpdateProgress(null);
        setUpdateBusy(false);
      } else {
        setUpdateStatus({ text: t("settings.upgradedRestarting"), available: false });
      }
    } catch (err) {
      setUpdateStatus({ text: `${t("settings.upgradeFailed")}: ${err.message || err}`, available: true });
      setUpdateProgress(null);
      setUpdateBusy(false);
    }
  };

  return (
    <>
      <div className="set-row">
        <div className="set-row-text">
          <div className="set-row-title">{t("settings.update")}</div>
          <div className="set-row-desc">{statusText}</div>
        </div>
        <div className="set-row-control settings-update-btns">
          <button type="button" className="login-btn" disabled={busy} onClick={check}>{t("settings.checkUpdates")}</button>
          {status.available && (
            <button type="button" className="login-btn" disabled={busy} onClick={install}>
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

function AgentVendor({ id, title, children }) {
  return (
    <section className="panel agent-vendor" id={id}>
      <div className="set-group-label agent-vendor-title">
        <BrandIcon of={title} size={15} />
        <span>{title}</span>
      </div>
      <div className="agent-vendor-content">{children}</div>
    </section>
  );
}

const PANEL_GROUPS = [
  {
    key: "appearance",
    labelKey: "settings.groupAppearance",
    panels: ["general", "display"],
  },
  {
    key: "account",
    labelKey: "settings.groupAccount",
    panels: ["kimi", "codex", "glm", "deepseek"],
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
  const [activeGroup, setActiveGroup] = useState(() => {
    try { return localStorage.getItem("env-tools.settings-focus-agent") ? "account" : "appearance"; } catch { return "appearance"; }
  });
  const [focusProvider] = useState(() => {
    try { return localStorage.getItem("env-tools.settings-focus-agent") || ""; } catch { return ""; }
  });
  const [settings, setSettings] = useState(null);
  const [backend, setBackend] = useState(null);
  useLang();

  const refreshSettings = useCallback(async () => {
    try {
      const result = await window.api.getSettings();
      if (result && result.ok) setSettings(result);
    } catch {}
    try { setBackend(await window.api.getBackendStatus()); } catch {}
  }, []);

  useEffect(() => { refreshSettings(); }, [refreshSettings]);
  useEffect(() => {
    if (!focusProvider) return;
    try { localStorage.removeItem("env-tools.settings-focus-agent"); } catch {}
    const timer = setTimeout(() => {
      document.getElementById(`panel-agent-${focusProvider}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 300);
    return () => clearTimeout(timer);
  }, [focusProvider]);

  const groupClass = (key) => `panel-group${activeGroup === key ? "" : " hidden"}`;
  const envAvailable = (() => {
    const available = (settings && settings.available_environments) || [];
    const distros = (settings && settings.wsl_distros) || [];
    return available.length >= 2 || distros.length > 0;
  })();
  const activeLabel = (PANEL_GROUPS.find((g) => g.key === activeGroup) || PANEL_GROUPS[0]).labelKey;
  const onMembershipSaved = (result) => {
    setSettings((prev) => ({
      ...(prev || {}), ...result.settings,
      ...(result.membership ? { membership: result.membership } : {}),
    }));
  };

  return (
    <div className="app-body settings-body">
      <nav className="settings-sidebar main-settings-nav" aria-label={t("tip.settings")}>
        <button type="button" className="settings-back" onClick={() => { window.location.hash = "#/dashboard"; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m14 5-7 7 7 7" />
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
            {Object.keys(AGENT_ACCOUNTS).map((provider) => (
              <AgentAccountsPanel
                key={provider}
                provider={provider}
                settings={settings}
                lastPayload={lastPayload}
                onSaved={onMembershipSaved}
              />
            ))}
          </div>
          <div className={groupClass("environment")}>
            <EnvironmentPanel
              settings={settings}
              onSaved={(next) => setSettings((prev) => ({ ...(prev || {}), ...next }))}
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
