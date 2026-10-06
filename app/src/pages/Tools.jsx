// Tools 页：Env-Tools 其它组件（nodejs / kdesk / openssh / ai-tools）的图形化
// 安装与升级入口。v0.7.11 起按平台 Tab（Windows / WSL）分区管理，不再混排；
// WSL Tab 顶部为发行版条：展示系统版本（os-release），点击可切换组件管理
// 目标（与设置页的数据源发行版解耦；无 bash 的发行版不可选）。
// Remote targets 收进 "+" 按钮展开。动作统一跑仓库根的 setup 脚本（WSL 内
// 交互式 bash 以保留 NVM/PATH），输出按行流式滚动；openssh 额外提供状态查看。

import { useEffect, useRef, useState } from "react";
import { useInstallState, setInstallRunning, setInstallResult, clearInstallLog } from "../installState.js";
import { t, useLang } from "../i18n.js";
import { isNewerVersion, activateOnKeys } from "../utils.js";

const COMPONENTS = [
  {
    key: "ai-tools",
    name: "AI Tools",
    platforms: ["linux", "windows"],
    descKey: "tools.descAiTools",
    actions: [
      { key: "kimi", detect: "kimi", agent: "Kimi" },
      { key: "codex", detect: "codex", agent: "Codex" },
    ],
  },
  {
    key: "nodejs",
    name: "Node.js",
    platforms: ["linux", "windows"],
    descKey: "tools.descNodejs",
    actions: [{ key: "nodejs", detect: "node" }],
  },
  {
    key: "kdesk",
    name: "KDesk",
    platforms: ["windows"],
    descKey: "tools.descKdesk",
    actions: [{ key: "kdesk", detect: "kdesk" }],
  },
  {
    key: "openssh",
    name: "OpenSSH Server",
    platforms: ["linux", "windows"],
    descKey: "tools.descOpenssh",
    actions: [
      { key: "openssh", detect: "openssh" },
      { key: "openssh:status", labelKey: "tools.checkStatus", ghost: true },
    ],
  },
];

// ai-tools 卡的 agent 版本行：当前版本来自当前 Tab 的组件探测（Windows 经
// cmd.exe、WSL 在发行版内），最新版本取 usage 载荷（npm/github 与平台无关）。
// 有更新时徽章可点击直接升级（与用量配额卡的版本徽章同语义）。
function AgentVersionRow({ payloadVersions, detected, disabled, onUpgrade }) {
  const agents = [
    { key: "kimi", label: "Kimi", payloadKey: "Kimi Code" },
    { key: "codex", label: "Codex", payloadKey: "OpenAI Codex" },
  ];
  return (
    <div className="tool-vers">
      {agents.map((agent) => {
        const current = (detected && detected[agent.key]) || null;
        const latest = ((payloadVersions[agent.payloadKey] || {}).latest) || "";
        const newer = current && latest && isNewerVersion(latest, current);
        const clickable = newer && !disabled;
        const fire = () => onUpgrade(agent.key, `${t("tools.update")} ${agent.label}`);
        return (
          <span
            key={agent.key}
            className={`tool-ver${clickable ? " upgrade" : ""}`}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            title={clickable ? t("upgrade.click") : undefined}
            onClick={clickable ? fire : undefined}
            onKeyDown={clickable ? activateOnKeys(fire) : undefined}
          >
            {agent.label}
            {current ? ` v${current}` : ""}
            {newer ? <span className="new"> → {latest}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

const TAB_KEY = "tools.platform-tab";
// WSL Tab 的组件管理目标发行版（与设置页的数据源发行版解耦：装哪台就探哪台，
// 不连带改分析数据源）。空串 = 未定，回退数据源发行版。
const WSL_TARGET_KEY = "tools.wsl-target";

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
  // 运行状态与日志来自全局 installState：切页后回来仍在（升级/安装常驻）
  const install = useInstallState();
  const running = install.running;
  const log = install.log;
  const result = install.result;
  const setRunning = setInstallRunning;
  const clearTerm = clearInstallLog;
  const [statuses, setStatuses] = useState({});
  // 当前 Tab 的组件探测：{kimi,codex,node:版本|null, openssh,kdesk:bool}
  const [detected, setDetected] = useState(null);
  // WSL Tab 的发行版清单：[{name, version, current, manageable}]，null=未加载
  const [wslDistros, setWslDistros] = useState(null);
  // 组件管理目标（仅影响 Tools 页动作，持久化在 localStorage）
  const [wslTarget, setWslTarget] = useState(() => {
    try { return localStorage.getItem(WSL_TARGET_KEY) || ""; } catch { return ""; }
  });
  const [backend, setBackend] = useState(null);
  const [sshList, setSshList] = useState([]);
  const [sshForm, setSshForm] = useState({ host: "", port: "22", user: "" });
  const [sshBusy, setSshBusy] = useState("");
  const [sshNote, setSshNote] = useState("");
  const logRef = useRef(null);

  const data = (lastPayload && lastPayload.data) || {};
  const environment = data.environment || "wsl";
  const versions = data.versions || {};
  const windowsSetupScript = data.windows_setup_script || "";

  useEffect(() => {
    (async () => {
      try { setBackend(await window.api.getBackendStatus()); } catch {}
      try {
        const result = await window.api.sshList();
        if (result && result.connections) setSshList(result.connections);
      } catch {}
    })();
  }, []);

  const selectTab = (tab) => {
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
      setSshNote(result && result.ok
        ? t("tools.connectedNote").replace("{host}", host)
        : t("tools.failedNote").replace("{err}", (result && result.error) || t("state.unknownError")));
      await window.api.listTargets();
    } catch (err) {
      setSshNote(t("tools.failedNote").replace("{err}", String(err.message || err)));
    } finally {
      setSshBusy("");
    }
  };

  const refreshSshStatus = async () => {
    setStatuses((prev) => ({ ...prev, openssh: { busy: true } }));
    try {
      const result = await window.api.componentStatus(
        "openssh", platformTab, platformTab === "wsl" ? wslTarget : undefined);
      setStatuses((prev) => ({ ...prev, openssh: { output: result.output || result.error || "" } }));
    } catch (err) {
      setStatuses((prev) => ({ ...prev, openssh: { output: String(err.message || err) } }));
    }
  };

  const detectComponents = () => {
    window.api.componentDetect(platformTab, platformTab === "wsl" ? wslTarget : undefined)
      .then((result) => { if (result && result.ok) setDetected(result.components || {}); })
      .catch(() => {});
  };

  useEffect(() => {
    // 切换平台 Tab 或管理目标发行版时刷新 openssh 状态与组件探测。
    // WSL Tab 目标未定时等清单到达再探（否则先探数据源发行版、清单到达
    // 再探一次目标，双份 wsl 冷启动）；清单拉取失败时 wslDistros 为空数组，
    // 以空目标探测，主进程回落数据源发行版。
    if (platformTab === "wsl" && !wslTarget && wslDistros === null) return;
    refreshSshStatus();
    detectComponents();
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
    // 冷启动要几秒，按需加载且只拉一次；失败置空列表，探测走数据源回退）
    if (platformTab !== "wsl" || wslDistros) return;
    window.api.wslDistros()
      .then((result) => { if (result && result.ok) setWslDistros(result.distros || []); })
      .catch(() => setWslDistros([]));
  }, [platformTab, wslDistros]);

  const run = async (actionKey, label) => {
    if (running) return;
    if (actionKey.endsWith(":status")) {
      await refreshSshStatus();
      return;
    }
    setInstallRunning({ label });
    clearInstallLog();
    try {
      const result = await window.api.runComponent(
        actionKey, platformTab, windowsSetupScript, platformTab === "wsl" ? wslTarget : undefined);
      setInstallResult({ ok: Boolean(result && result.ok), error: result && result.error });
    } catch (err) {
      setInstallResult({ ok: false, error: String(err.message || err) });
    }
  };

  // Tab 值是 wsl，组件平台清单用 linux（v0.3.0 的映射在 v0.7.11 Tab 改造时丢失）
  const visibleComponents = COMPONENTS.filter((component) =>
    component.platforms.includes(platformTab === "windows" ? "windows" : "linux"));

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
            const clickable = distro.manageable && !selected && !running;
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

      <div className="tools-grid">
        {visibleComponents.map((component) => (
          <div className="tool-card" key={component.key}>
            <div className="tool-head">
              <span className="tool-name">{component.name}</span>
              <span className="tool-platform">
                {platformTab === "windows" ? "Windows" : "Linux"}
              </span>
            </div>
            <div className="tool-desc">{t(component.descKey)}</div>
            {component.key === "ai-tools" ? (
              <AgentVersionRow
                platform={platformTab}
                payloadVersions={versions}
                detected={detected}
                disabled={Boolean(running)}
                onUpgrade={(key, label) => run(key, label)}
              />
            ) : null}
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
                      disabled={Boolean(running)}
                      onClick={() => run(action.key, t(action.labelKey))}
                    >
                      {running && running.label === t(action.labelKey) ? t("tools.running") : t(action.labelKey)}
                    </button>
                  );
                }
                const installed = Boolean(detected && detected[action.detect]);
                const label = `${t(installed ? "tools.update" : "tools.install")}${action.agent ? ` ${action.agent}` : ""}`;
                return (
                  <button
                    type="button"
                    key={action.key}
                    className={`tool-btn${action.ghost ? " ghost" : ""}`}
                    disabled={Boolean(running)}
                    onClick={() => run(action.key, label)}
                  >
                    {running && running.label === label ? t("tools.running") : label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>{t("tools.runtime")}</h2>
        <div className="about-row"><span>{t("tools.dataEngine")}</span><strong>{backend ? backend.engine : t("tools.checking")}</strong></div>
        <div className="about-row"><span>{t("tools.apiPort")}</span><strong>{backend && backend.port ? `127.0.0.1:${backend.port}` : "—"}</strong></div>
        <div className="about-row"><span>{t("tools.script")}</span><strong className="about-path">{backend && backend.detail ? backend.detail.script : "—"}</strong></div>
      </div>

      {/* 终端风格安装日志面板：不再使用弹框蒙版 */}
      <section className="card tools-terminal">
        <div className="term-head">
          <span className="term-dot" />
          <span className="term-title">{t("tools.installLog")}</span>
          <span className={`term-status${result && !result.ok ? " err" : ""}${running ? " run" : ""}`}>
            {running
              ? `● ${running.label}`
              : result
                ? result.ok ? "✓ done" : `✗ failed: ${result.error || "unknown error"}`
                : log.length ? "— finished" : "idle"}
          </span>
          <span className="term-spacer" />
          {running && (
            <button
              type="button"
              className="term-btn"
              onClick={async () => {
                try { await window.api.cancelInstall(); } catch {}
              }}
            >
              Cancel
            </button>
          )}
          {!running && log.length > 0 && (
            <button type="button" className="term-btn" onClick={clearTerm}>
              Clear
            </button>
          )}
        </div>
        <div className="term-body" ref={logRef}>
          {log.length === 0 && !running ? (
            <div className="term-line dim">ready — pick an install action above, logs stream here.</div>
          ) : (
            log.map((line, i) => {
              const lowered = line.toLowerCase();
              const cls = /error|fail|失败|err\]/.test(lowered) ? " err"
                : /^result\|/.test(line) || /success|done|已是最新|安装完成/.test(lowered) ? " ok" : "";
              return <div className={`term-line${cls}`} key={i}>{line}</div>;
            })
          )}
          {running && <div className="term-line dim">▋</div>}
        </div>
      </section>
    </div>
  );
}
