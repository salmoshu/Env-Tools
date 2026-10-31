// Tools 页：独立组件按 Agent、开发工具、系统工具分类管理。
// 安装与升级入口。v0.7.11 起按平台 Tab（Windows / WSL）分区管理，不再混排；
// WSL Tab 顶部为发行版条：展示系统版本（os-release），点击可切换组件管理
// 目标（与设置页的数据源发行版解耦；无 bash 的发行版不可选）。
// Remote targets 收进 "+" 按钮展开。动作统一跑仓库根的 setup 脚本（WSL 内
// 交互式 bash 以保留 NVM/PATH），输出按行流式滚动；openssh 额外提供状态查看。

import { useEffect, useRef, useState } from "react";
import { useInstallState, setInstallRunning, setInstallResult, clearInstallLog, busyComponents } from "../installState.js";
import { t, useLang } from "../i18n.js";
import { isNewerVersion, activateOnKeys } from "../utils.js";
import BrandIcon from "../components/BrandIcon.jsx";
import { showToast } from "../toast.jsx";

const CATEGORIES = ["agents", "development", "system"];

const COMPONENTS = [
  {
    key: "kimi",
    name: "Kimi Code",
    category: "agents",
    payloadKey: "Kimi Code",
    detect: "kimi",
    platforms: ["linux", "windows"],
    descKey: "tools.descKimi",
    actions: [{ key: "kimi", detect: "kimi" }],
  },
  {
    key: "codex",
    name: "Codex",
    category: "agents",
    payloadKey: "OpenAI Codex",
    detect: "codex",
    platforms: ["linux", "windows"],
    descKey: "tools.descCodex",
    actions: [{ key: "codex", detect: "codex" }],
  },
  {
    key: "entire",
    name: "Entire CLI",
    category: "development",
    detect: "entire",
    platforms: ["linux", "windows"],
    descKey: "tools.descEntire",
    actions: [{ key: "entire", detect: "entire" }],
  },
  {
    key: "zcode",
    name: "ZCode",
    category: "agents",
    payloadKey: "ZCode",
    detect: "zcode",
    platforms: ["windows"],
    descKey: "tools.descZcode",
    actions: [{ key: "zcode", detect: "zcode" }],
  },
  {
    key: "nodejs",
    name: "Node.js",
    category: "development",
    detect: "node",
    platforms: ["linux", "windows"],
    descKey: "tools.descNodejs",
    actions: [{ key: "nodejs", detect: "node" }],
  },
  {
    key: "kdesk",
    name: "KDesk",
    category: "system",
    platforms: ["windows"],
    descKey: "tools.descKdesk",
    actions: [{ key: "kdesk", detect: "kdesk" }],
  },
  {
    key: "openssh",
    name: "OpenSSH Server",
    category: "system",
    platforms: ["linux", "windows"],
    descKey: "tools.descOpenssh",
    actions: [
      { key: "openssh", detect: "openssh" },
      { key: "openssh:status", labelKey: "tools.checkStatus", ghost: true },
    ],
  },
];

// 每个组件的版本只读取当前平台/发行版的探测结果。
function ComponentVersion({ component, versions, detected, disabled, onUpgrade }) {
  if (!component.detect) return null;
  const current = detected && detected[component.detect];
  const latest = (versions[component.payloadKey] || {}).latest;
  const newer = current && latest && isNewerVersion(latest, current);
  const clickable = newer && !disabled;
  const fire = () => onUpgrade(component.key, `${t("tools.update")} ${component.name}`);
  return (
    <div className="tool-vers">
      <span
        className={`tool-ver${clickable ? " upgrade" : ""}`}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        title={clickable ? t("upgrade.click") : undefined}
        onClick={clickable ? fire : undefined}
        onKeyDown={clickable ? activateOnKeys(fire) : undefined}
      >
        {detected === null ? t("tools.checking") : current ? `v${current}` : t("tools.notInstalled")}
        {newer ? <span className="new"> → {latest}</span> : null}
      </span>
    </div>
  );
}

const TAB_KEY = "tools.platform-tab";
// WSL Tab 的组件管理目标发行版（与设置页的数据源发行版解耦：装哪台就探哪台，
// 不连带改分析数据源）。空串 = 未定，回退数据源发行版。
const WSL_TARGET_KEY = "tools.wsl-target";
const CATEGORY_KEY = "tools.category";

// 切页回来不重复探测：组件版本/发行版清单在模块级缓存 60s，
// 避免每次进入组件管理都重新起一批 wsl/cmd 子进程（切页卡顿来源）
const detectCache = new Map();
let distroCache = { value: null, at: 0 };
const DETECT_CACHE_MS = 60 * 1000;

export default function Tools({ lastPayload }) {
  useLang();
  const [platformTab, setPlatformTab] = useState(() => {
    try {
      const stored = localStorage.getItem(TAB_KEY);
      if (stored === "windows" || stored === "wsl") return stored;
    } catch {}
    return "windows";
  });
  const [showRemote, setShowRemote] = useState(false);
  const [category, setCategory] = useState(() => {
    try {
      const stored = localStorage.getItem(CATEGORY_KEY);
      if (CATEGORIES.includes(stored)) return stored;
    } catch {}
    return "all";
  });
  // 运行状态与日志来自全局 installState：切页后回来仍在（升级/安装常驻）
  const install = useInstallState();
  const running = install.running;
  const runs = install.runs || {};
  const runCount = Object.keys(runs).length;
  // 只禁用正在安装的那个组件，其余组件可并发操作
  const busy = busyComponents(install);
  const log = install.log;
  const result = install.result;
  const [logFilter, setLogFilter] = useState("all");
  const clearTerm = clearInstallLog;
  const [statuses, setStatuses] = useState({});
  // 当前 Tab 的组件探测：{kimi,codex,entire,node:版本|null, openssh,kdesk:bool}
  const [detected, setDetected] = useState(null);
  const [detectError, setDetectError] = useState(false);
  // WSL Tab 的发行版清单：[{name, version, current, manageable}]，null=未加载
  const [wslDistros, setWslDistros] = useState(null);
  // 组件管理目标（仅影响 Tools 页动作，持久化在 localStorage）
  const [wslTarget, setWslTarget] = useState(() => {
    try { return localStorage.getItem(WSL_TARGET_KEY) || ""; } catch { return ""; }
  });
  const [sshList, setSshList] = useState([]);
  const [sshForm, setSshForm] = useState({ host: "", port: "22", user: "" });
  const [sshBusy, setSshBusy] = useState("");
  const [sshNote, setSshNote] = useState("");
  const logRef = useRef(null);
  const detectRequest = useRef(0);
  const statusRequest = useRef(0);

  const data = (lastPayload && lastPayload.data) || {};
  const environment = data.environment || "wsl";
  const versions = data.versions || {};
  const windowsSetupScript = data.windows_setup_script || "";

  useEffect(() => {
    (async () => {
      try {
        const result = await window.api.sshList();
        if (result && result.connections) setSshList(result.connections);
      } catch {}
    })();
  }, []);

  const selectTab = (tab) => {
    setDetected(null);
    setStatuses({});
    setPlatformTab(tab);
    try { localStorage.setItem(TAB_KEY, tab); } catch {}
  };

  const saveSsh = async (list) => {
    const result = await window.api.sshSave(list);
    if (result && result.connections) setSshList(result.connections);
  };

  const connectSsh = async (host) => {
    setSshBusy(host);
    setSshNote(t("tools.connectingNote").replace("{host}", host));
    try {
      const result = await window.api.sshConnect(host);
      if (result && result.ok) {
        showToast(t("tools.connectedNote").replace("{host}", host), "ok");
        setSshNote("");
      } else {
        const message = t("tools.failedNote").replace("{err}", (result && result.error) || t("state.unknownError"));
        setSshNote(message);
        showToast(message, "error", 6000);
      }
      await window.api.listTargets();
    } catch (err) {
      const message = t("tools.failedNote").replace("{err}", String(err.message || err));
      setSshNote(message);
      showToast(message, "error", 6000);
    } finally {
      setSshBusy("");
    }
  };

  const refreshSshStatus = async () => {
    const request = ++statusRequest.current;
    setStatuses((prev) => ({ ...prev, openssh: { busy: true } }));
    try {
      const result = await window.api.componentStatus(
        "openssh", platformTab, platformTab === "wsl" ? wslTarget : undefined);
      if (request === statusRequest.current) setStatuses((prev) => ({ ...prev, openssh: { output: result.output || result.error || "" } }));
    } catch (err) {
      if (request === statusRequest.current) setStatuses((prev) => ({ ...prev, openssh: { output: String(err.message || err) } }));
    }
  };

  const detectComponents = () => {
    const request = ++detectRequest.current;
    const cacheKey = `${platformTab}|${wslTarget}`;
    const cached = detectCache.get(cacheKey);
    if (cached && Date.now() - cached.at < DETECT_CACHE_MS) {
      // 有新鲜缓存直接渲染，后台再探一次；没有缓存才显示"检测中"
      setDetected(cached.components);
    } else {
      setDetected(null);
    }
    setDetectError(false);
    window.api.componentDetect(platformTab, platformTab === "wsl" ? wslTarget : undefined)
      .then((result) => {
        if (request !== detectRequest.current) return;
        if (result && result.ok) {
          const components = result.components || {};
          detectCache.set(cacheKey, { components, at: Date.now() });
          setDetected(components);
        } else setDetectError(true);
      })
      .catch(() => { if (request === detectRequest.current) setDetectError(true); });
  };

  useEffect(() => {
    // 切换平台 Tab 或管理目标发行版时刷新 openssh 状态与组件探测。
    // WSL Tab 目标未定时等清单到达再探（否则先探数据源发行版、清单到达
    // 再探一次目标，双份 wsl 冷启动）；清单拉取失败时 wslDistros 为空数组，
    // 以空目标探测，主进程回落数据源发行版。
    if (platformTab === "wsl" && !wslTarget && wslDistros === null) return;
    refreshSshStatus();
    detectComponents();
    return () => { detectRequest.current++; statusRequest.current++; };
  }, [platformTab, wslTarget, wslDistros]);

  useEffect(() => {
    // 清单就绪后校验管理目标：已存偏好仍可用则保留；否则取数据源发行版，
    // 再退而取第一个可管理发行版（docker-desktop 等无 bash 的不可选）
    if (!wslDistros || wslDistros.length === 0) return;
    const manageable = wslDistros.filter((d) => d.manageable);
    if (manageable.length === 0) return;
    if (manageable.some((d) => d.name === wslTarget)) return;
    const next = (manageable.find((d) => d.current) || manageable[0]).name;
    setWslTarget(next);
    try { localStorage.setItem(WSL_TARGET_KEY, next); } catch {}
  }, [wslDistros, wslTarget]);

  useEffect(() => {
    // 安装/升级结束后重探测，按钮文案随之从“安装”切到“更新”
    if (install.result) detectComponents();
  }, [install.result]);

  useEffect(() => {
    // 首次切到 WSL Tab 时拉取发行版清单（逐发行版进 distro 读 os-release，
    // 冷启动要几秒，按需加载且只拉一次；失败置空列表，探测走数据源回退）。
    // 60s 内切页复用缓存，不再逐发行版重启 wsl 子进程
    if (platformTab !== "wsl") return;
    if (wslDistros) return;
    if (distroCache.value && Date.now() - distroCache.at < DETECT_CACHE_MS) {
      setWslDistros(distroCache.value);
      return;
    }
    window.api.wslDistros()
      .then((result) => {
        const distros = result && result.ok ? result.distros || [] : [];
        distroCache = { value: distros, at: Date.now() };
        setWslDistros(distros);
      })
      .catch(() => setWslDistros([]));
  }, [platformTab, wslDistros]);

  const run = async (actionKey, label) => {
    if (busy.has(actionKey)) return;
    if (actionKey.endsWith(":status")) {
      await refreshSshStatus();
      return;
    }
    // 不再清空日志：并发安装时其它组件的输出要保留，按 runKey 分流
    const currentRun = setInstallRunning({ label, component: actionKey });
    try {
      const result = await window.api.runComponent(
        actionKey, platformTab, windowsSetupScript, platformTab === "wsl" ? wslTarget : undefined);
      setInstallResult({ ok: Boolean(result && result.ok), error: result && result.error }, currentRun);
    } catch (err) {
      setInstallResult({ ok: false, error: String(err.message || err) }, currentRun);
    }
  };

  // Tab 值是 wsl，组件平台清单用 linux（v0.3.0 的映射在 v0.7.11 Tab 改造时丢失）
  const visibleComponents = COMPONENTS.filter((component) =>
    component.platforms.includes(platformTab === "windows" ? "windows" : "linux"));

  // 日志按 runKey 分流：过滤下拉列出出现过日志的组件与仍在运行的组件
  const logKeys = [];
  const logLabels = {};
  for (const entry of log) {
    if (entry.key && !logLabels[entry.key]) {
      logLabels[entry.key] = entry.label;
      logKeys.push(entry.key);
    }
  }
  for (const key of Object.keys(runs)) {
    if (!logLabels[key]) {
      logLabels[key] = runs[key].label;
      logKeys.push(key);
    }
  }
  const logEntries = logFilter === "all" ? log : log.filter((entry) => entry.key === logFilter);
  const showPrefix = logFilter === "all" && logKeys.length > 1;
  const cancelKey = logFilter !== "all" && runs[logFilter] ? logFilter : undefined;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("nav.tools")}</h1>
          <div className="meta">
            {t("tools.meta").replace("{env}", environment)}
          </div>
        </div>
      </header>

      <div className="tools-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={platformTab === "windows"}
          className={`tools-tab${platformTab === "windows" ? " active" : ""}`}
          onClick={() => selectTab("windows")}
        >
          Windows
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={platformTab === "wsl"}
          className={`tools-tab${platformTab === "wsl" ? " active" : ""}`}
          onClick={() => selectTab("wsl")}
        >
          WSL
        </button>
        <span className="tools-tabs-spacer" />
        <button
          type="button"
          className={`tools-tab tools-add${showRemote ? " active" : ""}`}
          title={t("tools.remote")}
          onClick={() => setShowRemote((v) => !v)}
        >
          +
        </button>
      </div>

      {showRemote && (
        <section className="card tools-remote">
          <h2>{t("tools.remote")}</h2>
          <div className="panel-hint">{t("tools.remoteHint")}</div>
          {sshList.map((c) => (
            <div className="login-row" key={c.host}>
              <div className="login-info">
                <div className="login-name">{c.user ? `${c.user}@` : ""}{c.host}</div>
                <div className="login-method">port {c.port}</div>
              </div>
              <button
                type="button"
                className="login-btn"
                disabled={Boolean(sshBusy)}
                onClick={() => connectSsh(c.host)}
              >
                {sshBusy === c.host ? t("tools.connecting") : t("tools.connect")}
              </button>
              <button
                type="button"
                className="login-btn"
                style={{ background: "transparent", color: "var(--faint)", borderColor: "var(--border)" }}
                onClick={async () => {
                  await window.api.sshDisconnect(c.host);
                  await saveSsh(sshList.filter((item) => item.host !== c.host));
                }}
              >
                {t("tools.remove")}
              </button>
            </div>
          ))}
          <div className="membership-inputs" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <input
              className="key-input" style={{ flex: "2", minWidth: 140 }} placeholder={t("tools.hostPh")}
              value={sshForm.host}
              onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })}
            />
            <input
              className="key-input" style={{ flex: "0 0 80px" }} placeholder={t("tools.portPh")}
              value={sshForm.port}
              onChange={(e) => setSshForm({ ...sshForm, port: e.target.value })}
            />
            <input
              className="key-input" style={{ flex: "1", minWidth: 110 }} placeholder={t("tools.userPh")}
              value={sshForm.user}
              onChange={(e) => setSshForm({ ...sshForm, user: e.target.value })}
            />
            <button
              type="button"
              className="login-btn"
              disabled={!sshForm.host.trim()}
              onClick={async () => {
                await saveSsh([...sshList, {
                  host: sshForm.host.trim(),
                  port: Number(sshForm.port) || 22,
                  user: sshForm.user.trim(),
                }]);
                setSshForm({ host: "", port: "22", user: "" });
              }}
            >
              {t("tools.add")}
            </button>
          </div>
          {sshNote ? <div className="settings-note" style={{ marginTop: 6 }}>{sshNote}</div> : null}
        </section>
      )}

      {platformTab === "wsl" && wslDistros && wslDistros.length > 0 && (
        <div className="wsl-distros">
          <span className="wsl-distros-label">{t("tools.wslDistros")}</span>
          {wslDistros.map((distro) => {
            const selected = distro.name === wslTarget;
            const clickable = distro.manageable && !selected;
            const fire = () => {
              if (!clickable) return;
              setWslTarget(distro.name);
              try { localStorage.setItem(WSL_TARGET_KEY, distro.name); } catch {}
              setDetected(null); // 旧目标的探测结果作废，effect 重探
            };
            return (
              <span
                key={distro.name}
                className={`wsl-distro${selected ? " current" : ""}${distro.manageable ? "" : " disabled"}`}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                title={!distro.manageable
                  ? t("tools.wslNotManageable")
                  : clickable ? t("tools.wslTargetHint") : undefined}
                onClick={clickable ? fire : undefined}
                onKeyDown={clickable ? activateOnKeys(fire) : undefined}
              >
                <span className="wsl-distro-name">{distro.name}</span>
                {distro.version ? <span className="wsl-distro-ver">{distro.version}</span> : null}
                {selected ? <span className="wsl-distro-tag">{t("tools.wslCurrent")}</span> : null}
              </span>
            );
          })}
        </div>
      )}

      <div className="tools-categories" role="group" aria-label={t("tools.categories")}>
        {["all", ...CATEGORIES].map((key) => (
          <button
            type="button" key={key} className={`tools-category${category === key ? " active" : ""}`}
            aria-pressed={category === key}
            onClick={() => {
              setCategory(key);
              try { localStorage.setItem(CATEGORY_KEY, key); } catch {}
            }}
          >
            {t(`tools.category.${key}`)}
            <span className="tools-category-count">{visibleComponents.filter((c) => key === "all" || c.category === key).length}</span>
          </button>
        ))}
      </div>

      {detectError && (
        <div className="tools-detect-error" role="status">
          <span>{t("tools.detectFailed")}</span>
          <button type="button" className="tool-btn ghost" onClick={detectComponents}>{t("tools.retryDetect")}</button>
        </div>
      )}

      {CATEGORIES.filter((key) => category === "all" || category === key).map((key) => (
        <section className="tools-group" key={key}>
          <h2 className="tools-group-title">{t(`tools.category.${key}`)}</h2>
          <div className="tools-grid">
            {visibleComponents.filter((component) => component.category === key).map((component) => (
              <div className="tool-card" key={component.key} data-component={component.key}>
                <div className="tool-head">
                  <span className="tool-name">
                    {component.payloadKey ? <BrandIcon of={component.payloadKey} size={20} /> : null}
                    {component.name}
                  </span>
                  <span className="tool-platform">
                    {platformTab === "windows" ? "Windows" : "Linux"}
                  </span>
                </div>
                <div className="tool-desc">{t(component.descKey)}</div>
                <ComponentVersion
                  component={component}
                  versions={versions}
                  detected={detected}
                  disabled={busy.has(component.key)}
                  onUpgrade={(key, label) => run(key, label)}
                />
                {component.key === "openssh" && statuses.openssh && statuses.openssh.output ? (
                  <div className="tool-status">{statuses.openssh.output}</div>
                ) : null}
                <div className="tool-actions">
                  {component.actions.map((action) => {
                    if (action.labelKey) {
                      return (
                        <button
                          type="button"
                          key={action.key}
                          className={`tool-btn${action.ghost ? " ghost" : ""}`}
                          disabled={busy.has(action.key)}
                          onClick={() => run(action.key, t(action.labelKey))}
                        >
                          {busy.has(action.key) ? t("tools.running") : t(action.labelKey)}
                        </button>
                      );
                    }
                    const installed = Boolean(detected && detected[action.detect]);
                    const label = `${t(installed ? "tools.update" : "tools.install")} ${component.name}`;
                    return (
                      <button
                        type="button"
                        key={action.key}
                        className={`tool-btn${action.ghost ? " ghost" : ""}`}
                        disabled={busy.has(action.key) || detected === null}
                        onClick={() => run(action.key, label)}
                      >
                        {busy.has(action.key) ? t("tools.running") : detected === null ? t("tools.checking") : t(installed ? "tools.update" : "tools.install")}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* 终端风格安装日志面板：多场安装并发时按组件过滤，行内带组件标签 */}
      <section className="card tools-terminal">
        <div className="term-head">
          <span className="term-dot" />
          <span className="term-title">{t("tools.installLog")}</span>
          <span className={`term-status${result && !result.ok ? " err" : ""}${runCount ? " run" : ""}`}>
            {runCount
              ? `● ${runCount > 1 ? `${runCount} · ` : ""}${running.label}`
              : result
                ? result.ok ? "✓ done" : `✗ failed: ${result.error || "unknown error"}`
                : log.length ? "— finished" : "idle"}
          </span>
          <span className="term-spacer" />
          <select
            className="term-log-filter"
            value={logFilter}
            aria-label={t("tools.installLog")}
            onChange={(event) => setLogFilter(event.target.value)}
          >
            <option value="all">{t("tools.logAll")}</option>
            {logKeys.map((key) => (
              <option value={key} key={key}>{logLabels[key] || key}</option>
            ))}
          </select>
          {runCount > 0 && (
            <button
              type="button"
              className="term-btn"
              onClick={async () => {
                try { await window.api.cancelInstall(cancelKey); } catch {}
              }}
            >
              Cancel
            </button>
          )}
          {runCount === 0 && log.length > 0 && (
            <button type="button" className="term-btn" onClick={clearTerm}>
              Clear
            </button>
          )}
        </div>
        <div className="term-body" ref={logRef}>
          {logEntries.length === 0 && runCount === 0 ? (
            <div className="term-line dim">ready — pick an install action above, logs stream here.</div>
          ) : (
            logEntries.map((entry, i) => {
              const line = entry.line;
              const lowered = line.toLowerCase();
              const cls = /error|fail|失败|err\]/.test(lowered) ? " err"
                : /^result\|/.test(line) || /success|done|已是最新|安装完成/.test(lowered) ? " ok" : "";
              return (
                <div className={`term-line${cls}`} key={i}>
                  {showPrefix && entry.label && !/^\s*\[/.test(entry.line) ? `[${entry.label}] ` : ""}{line}
                </div>
              );
            })
          )}
          {runCount > 0 && <div className="term-line dim">▋</div>}
        </div>
      </section>
    </div>
  );
}
