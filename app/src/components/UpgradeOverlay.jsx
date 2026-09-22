// 升级浮层（看板小窗与主窗口仪表盘共用）：确认 → 执行 → 结果。
// 进度行由主进程 install-progress 广播驱动；payload 需含
// data.versions / data.environment（windows_setup_script 可选，缺省走主进程默认）。

import { useEffect, useRef, useState } from "react";
import { isNewerVersion } from "../utils.js";
import { t } from "../i18n.js";

export default function UpgradeOverlay({ provider, payload, onClose }) {
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
    setMessage(`${t("upgrade.running")} ${targets.join(", ")} …`);
    const startedAt = Date.now();
    const elapsed = setInterval(() => {
      setMessage(`${t("upgrade.running")} ${targets.join(", ")} … (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }, 1000);
    try {
      const data = (payload && payload.data) || {};
      const result = await window.api.upgrade(targets, data.environment, data.windows_setup_script);
      clearInterval(elapsed);
      if (result && result.ok) {
        setMessage(t("upgrade.done"));
        setPhase("done");
        setTimeout(onClose, 1600);
      } else {
        setMessage(`${t("upgrade.failed")}: ${(result && result.error) || "unknown error"}`);
        setPhase("failed");
      }
    } catch (err) {
      clearInterval(elapsed);
      setMessage(`${t("upgrade.failed")}: ${err.message || err}`);
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
            <button type="button" onClick={() => start([provider])}>{t("upgrade.action")} {provider}</button>
            {outdated.length > 1 && (
              <button type="button" onClick={() => start(outdated)}>{t("upgrade.all")} ({outdated.length})</button>
            )}
            <button type="button" className="ghost" onClick={onClose}>{t("upgrade.cancel")}</button>
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
                type="button"
                className="ghost"
                onClick={async (event) => {
                  event.target.disabled = true;
                  event.target.textContent = t("upgrade.cancelling");
                  try { await window.api.cancelInstall(); } catch {}
                }}
              >
                {t("upgrade.cancel")}
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
              <button type="button" className="ghost" onClick={onClose}>{t("upgrade.close")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
