import AgentAccountPicker from "./AgentAccountPicker.jsx";
import { AGENT_ACCOUNTS } from "../agentAccounts.js";
import { t } from "../i18n.js";

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
      {state.notice ? <span className="stale-tag" title={state.notice}>{t("dash.accountRestartTag")}</span> : null}
      {state.viewId && (state.accounts || []).length > 1 ? (
        <button
          type="button"
          className="login-btn agent-account-apply"
          title={t("dash.accountApplyHint")}
          disabled={state.switching || state.viewId === state.activeId}
          onClick={() => state.selectAccount(state.viewId)}
        >{t(state.switching ? "state.saving" : "settings.accountUse")}</button>
      ) : null}
    </div>
  );
}
