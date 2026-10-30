import { useEffect } from "react";
import AgentAccountPicker from "./AgentAccountPicker.jsx";
import { AGENT_ACCOUNTS } from "../agentAccounts.js";
import { t } from "../i18n.js";
import { showToast } from "../toast.jsx";

function RestartNotice({ text, onClose }) {
  useEffect(() => {
    if (!text) return;
    showToast(text, "info", 8000);
    onClose();
  }, [text, onClose]);
  return null;
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
      {state.viewId && state.viewId !== state.activeId && (state.accounts || []).length > 1 ? (
        <button
          type="button"
          className="login-btn agent-account-apply"
          title={t("dash.accountApplyHint")}
          disabled={state.switching}
          onClick={() => state.selectAccount(state.viewId)}
        >{t(state.switching ? "state.saving" : "dash.accountApply")}</button>
      ) : null}
      <RestartNotice text={state.notice} onClose={state.dismissNotice} />
    </div>
  );
}
