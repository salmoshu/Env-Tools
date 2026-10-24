import AgentAccountPicker from "./AgentAccountPicker.jsx";
import { AGENT_ACCOUNTS } from "../agentAccounts.js";
import { t } from "../i18n.js";

export default function AgentAccountControl({ provider, state }) {
  if (!provider || !state) return null;
  const hint = provider === "codex"
    ? t("dash.codexAccountHint")
    : t("dash.accountHint").replace("{provider}", AGENT_ACCOUNTS[provider].label);
  return (
    <AgentAccountPicker
      accounts={state.accounts}
      value={state.activeId}
      onChange={state.selectAccount}
      disabled={state.switching}
      error={state.error}
      errorLabel={t("dash.accountSwitchFailed")}
      hint={hint}
      emptyUsage={provider === "codex" ? "5h — · 7d —" : "—"}
    />
  );
}
