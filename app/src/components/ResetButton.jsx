import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

/**
 * 配额重置按钮（GLM 5h/7d 重置卡、Codex 速率限制重置额度）。
 * 防误触双保险：
 *   1) 父组件只在对应窗口用量 ≥95%（剩余 <5%）时才渲染本按钮；
 *   2) 点击后弹出确认对话框，明确告知将消耗一次机会，确认后才真正执行。
 * 主进程在重置成功后同步广播全新配额（await pushUsage 后才返回 IPC），
 * 结果提示出现时卡片数值已是重置后的状态；结果内联展示 6s 后自动复位。
 */
export default function ResetButton({ provider, resetType = null, what, disabled = false, children }) {
  const [phase, setPhase] = useState("idle"); // idle | confirm | pending | ok | err
  const [message, setMessage] = useState("");
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const later = (fn, ms) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  const reset = () => setPhase("idle");

  const run = async () => {
    setPhase("pending");
    try {
      const result = await window.api.quotaReset(provider, resetType);
      if (result && result.ok) {
        const data = result.data || {};
        if (provider === "codex") {
          // wham consume 的业务码：reset 才是真正重置，其余为未生效原因
          const code = data.code || "";
          const key = {
            reset: "dash.resetOk",
            nothing_to_reset: "dash.resetNothing",
            no_credit: "dash.resetNoCredit",
            already_redeemed: "dash.resetAlready",
          }[code] || "dash.resetOk";
          let text = t(key);
          if (code === "reset" && data.windows_reset) {
            text += ` · ${t("dash.resetWindows").replace("{n}", String(data.windows_reset))}`;
          }
          setMessage(text);
          setPhase(code === "reset" ? "ok" : "err");
        } else {
          setMessage(t("dash.resetOk"));
          setPhase("ok");
        }
        // quota-reset 在主进程内已同步广播全新配额（await pushUsage），
        // IPC 返回时卡片数值即是重置后的状态，无需再手动 refresh
      } else {
        setMessage(result && result.error ? String(result.error) : t("dash.resetFailed"));
        setPhase("err");
      }
    } catch (err) {
      setMessage(String((err && err.message) || err || t("dash.resetFailed")));
      setPhase("err");
    }
    later(reset, 6000);
  };

  // 结果反馈：行内短暂展示
  if (phase === "ok" || phase === "err") {
    return (
      <span className={`reset-action-result ${phase}`} title={message} onClick={reset}>
        {message}
      </span>
    );
  }
  const confirming = phase === "confirm" || phase === "pending";
  return (
    <>
      <button
        type="button"
        className="reset-action-btn"
        disabled={disabled}
        onClick={() => setPhase("confirm")}
      >
        {children}
      </button>
      {confirming ? (
        <div className="overlay" onClick={() => phase === "confirm" && reset()}>
          <div className="dialog" onClick={(event) => event.stopPropagation()}>
            <div className="dialog-title">{t("dash.resetDlgTitle")}</div>
            <div className="dialog-msg">
              {t("dash.resetDlgBody").replace("{what}", what || "")}
            </div>
            <div className="dialog-btns">
              <button type="button" disabled={phase === "pending"} onClick={run}>
                {phase === "pending" ? "…" : t("dash.resetDlgOk")}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={phase === "pending"}
                onClick={reset}
              >
                {t("dash.resetDlgCancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
