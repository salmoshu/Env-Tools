import { useEffect } from "react";
import AgentAccountPicker from "./AgentAccountPicker.jsx";
import { AGENT_ACCOUNTS } from "../agentAccounts.js";
import { t } from "../i18n.js";

// 切换后检测到仍在运行的 Codex 会话：弹框提醒，8 秒自动消失（也可手动关闭）
function RestartNotice({ text, onClose }) {
  useEffect(() => {
    if (!text) return undefined;
    const timer = setTimeout(onClose, 8000);
    return () => clearTimeout(timer);
  }, [text, onClose]);
  if (!text) return null;
  return (
    <div className="account-notice-mask" onClick={onClose}>
      <div
        className="account-notice"
        role="alertdialog"
        aria-label={text}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="account-notice-text">{text}</div>
        <button type="button" className="toast-close" aria-label="close" onClick={onClose}>×</button>
      </div>
    </div>
  );
}

export default function AgentAccountControl({ provider, state }) {
  if (!provider || !state) return null;
  const hint = provider === "codex"
    ? t("dash.codexAccountHint")
    : t("dash.accountHint").replace("{provider}", AGENT_ACCOUNTS[provider].label);
  return (
    <div className="agent-account-control">
      <AgentAccountPicker
        accounts={state.accounts}
        value={state.viewId}
        activeId={state.activeId}
        onChange={state.viewAccount}
        disabled={state.switching}
        error={state.error}
        errorLabel={t("dash.accountSwitchFailed")}
        hint={hint}
        emptyUsage={provider === "codex" ? "5h — · 7d —" : "—"}
      />
      {state.viewId && (state.accounts || []).length > 1 ? (
        <button
          type="button"
          className="login-btn agent-account-apply"
          title={t("dash.accountApplyHint")}
          disabled={state.switching || state.viewId === state.activeId}
          onClick={() => state.selectAccount(state.viewId)}
        >{t(state.switching ? "state.saving" : "dash.accountApply")}</button>
      ) : null}
      <RestartNotice text={state.notice} onClose={state.dismissNotice} />
    </div>
  );
}
