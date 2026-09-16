// Tools 页：Env-Tools 其它组件（nodejs / kdesk / openssh / ai-tools）的图形化
// 安装与升级入口。动作统一跑仓库根的 setup 脚本（WSL 内交互式 bash 以保留
// NVM/PATH），输出按行流式滚动；openssh 额外提供状态查看。

import { useEffect, useRef, useState } from "react";

const COMPONENTS = [
  {
    key: "ai-tools",
    name: "AI Tools",
    platforms: ["linux", "windows"],
    desc: "Kimi Code / OpenAI Codex CLI 的安装与升级；配额监控与设置见用量看板。",
    actions: [
      { key: "kimi", label: "Install / Update Kimi" },
      { key: "codex", label: "Install / Update Codex" },
    ],
  },
  {
    key: "nodejs",
    name: "Node.js",
    platforms: ["linux", "windows"],
    desc: "Node.js 环境部署（各组件 CLI 与工具链的运行时依赖）。",
    actions: [{ key: "nodejs", label: "Install / Update" }],
  },
  {
    key: "kdesk",
    name: "KDesk",
    platforms: ["windows"],
    desc: "元气桌面免安装便携部署 + 快照对抗自动升级（仅 Windows）。",
    actions: [{ key: "kdesk", label: "Install / Update" }],
  },
  {
    key: "openssh",
    name: "OpenSSH Server",
    platforms: ["linux", "windows"],
    desc: "OpenSSH Server 安装与配置；可查看 sshd 服务状态与连接示例。",
    actions: [
      { key: "openssh", label: "Install / Update" },
      { key: "openssh:status", label: "Check status", ghost: true },
    ],
  },
];

export default function Tools({ lastPayload }) {
  const [running, setRunning] = useState(null); // { label }
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null); // { ok, error }
  const [statuses, setStatuses] = useState({});
  const [backend, setBackend] = useState(null);
  const logRef = useRef(null);

  const data = (lastPayload && lastPayload.data) || {};
  const environment = data.environment || "wsl";
  const windowsSetupScript = data.windows_setup_script || "";

  useEffect(() => {
    (async () => {
      try { setBackend(await window.api.getBackendStatus()); } catch {}
    })();
    return window.api.onInstallProgress(({ line }) => {
      if (!line) return;
      setLog((prev) => [...prev.slice(-200), line]);
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }, []);

  const refreshSshStatus = async () => {
    setStatuses((prev) => ({ ...prev, openssh: { busy: true } }));
    try {
      const result = await window.api.componentStatus("openssh", environment);
      setStatuses((prev) => ({ ...prev, openssh: { output: result.output || result.error || "" } }));
    } catch (err) {
      setStatuses((prev) => ({ ...prev, openssh: { output: String(err.message || err) } }));
    }
  };

  useEffect(() => {
    // 进入页面自动拉一次 openssh 状态（失败静默，按钮可手动重试）
    refreshSshStatus();
  }, [environment]);

  const run = async (actionKey, label) => {
    if (running) return;
    if (actionKey.endsWith(":status")) {
      await refreshSshStatus();
      return;
    }
    setRunning({ label });
    setLog([]);
    setResult(null);
    try {
      const result = await window.api.runComponent(actionKey, environment, windowsSetupScript);
      setResult(result);
    } catch (err) {
      setResult({ ok: false, error: String(err.message || err) });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Tools</h1>
          <div className="meta">
            Components managed through the Env-Tools setup scripts · data source: {environment}
          </div>
        </div>
      </header>

      <div className="tools-grid">
        {COMPONENTS.map((component) => {
          const platformOk = component.platforms.includes(environment === "windows" ? "windows" : "linux")
            || (component.platforms.includes("windows") && environment === "windows");
          const disabledByPlatform = environment === "windows" && !component.platforms.includes("windows");
          return (
            <div className="tool-card" key={component.key}>
              <div className="tool-head">
                <span className="tool-name">{component.name}</span>
                <span className="tool-platform">
                  {component.platforms.includes("windows") && component.platforms.includes("linux")
                    ? "Windows · Linux"
                    : component.platforms.includes("windows") ? "Windows only" : "Linux"}
                </span>
              </div>
              <div className="tool-desc">{component.desc}</div>
              {component.key === "openssh" && statuses.openssh && statuses.openssh.output ? (
                <div className="tool-status">{statuses.openssh.output}</div>
              ) : null}
              <div className="tool-actions">
                {component.actions.map((action) => (
                  <button
                    key={action.key}
                    className={`tool-btn${action.ghost ? " ghost" : ""}`}
                    disabled={Boolean(running) || disabledByPlatform}
                    title={disabledByPlatform ? "Switch the data source to Windows to manage this component" : undefined}
                    onClick={() => run(action.key, action.label)}
                  >
                    {running && running.label === action.label ? "Running…" : action.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Runtime</h2>
        <div className="about-row"><span>Data engine</span><strong>{backend ? backend.engine : "checking…"}</strong></div>
        <div className="about-row"><span>API port</span><strong>{backend && backend.port ? `127.0.0.1:${backend.port}` : "—"}</strong></div>
        <div className="about-row"><span>Script</span><strong className="about-path">{backend && backend.detail ? backend.detail.script : "—"}</strong></div>
      </div>

      {(running || result || log.length > 0) && (
        <div className="overlay" style={{ alignItems: "flex-end", paddingBottom: 30 }}>
          <div className="dialog wide">
            <div className="dialog-title">{running ? running.label : "Install finished"}</div>
            {running && <div className="dialog-msg">Running the setup script… you can cancel below.</div>}
            {!running && result && (
              <div className="dialog-msg">
                {result.ok ? "Done." : `Failed: ${result.error || "unknown error"}`}
              </div>
            )}
            <div className="install-log" ref={logRef}>
              {log.slice(-60).map((line, i) => <div key={i}>{line}</div>)}
            </div>
            <div className="dialog-btns">
              {running ? (
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
              ) : (
                <button className="ghost" onClick={() => { setLog([]); setResult(null); }}>Close</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
