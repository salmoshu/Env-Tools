import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n.js";
import { agentAccountId, agentAccountLabel } from "./components/AgentAccountPicker.jsx";

export const AGENT_ACCOUNTS = {
  kimi: { label: "Kimi Code", quotaProvider: "Kimi Code", membershipPrefix: "kimi", credential: "login" },
  codex: { label: "OpenAI Codex", quotaProvider: "OpenAI Codex", membershipPrefix: "openai", credential: "login" },
  glm: { label: "GLM / BigModel", quotaProvider: "GLM", membershipPrefix: "glm", credential: "apiKey" },
  deepseek: { label: "DeepSeek", quotaProvider: "DeepSeek", membershipPrefix: "deepseek", credential: "apiKey" },
};

export function agentProviderKey(quotaProvider) {
  if (quotaProvider === "Kimi Monthly Total") return "kimi";
  return Object.keys(AGENT_ACCOUNTS).find((provider) => AGENT_ACCOUNTS[provider].quotaProvider === quotaProvider) || "";
}

export function agentAccountSelectionKey(provider) {
  return `ai-usage-monitor.${provider}-account`;
}

export function agentAccountViewKey(provider) {
  return `ai-usage-monitor.${provider}-account-view`;
}

export function agentMembershipKey(provider, account) {
  const prefix = AGENT_ACCOUNTS[provider].membershipPrefix;
  return account.membership_key || (account.id === "default" ? prefix : `${prefix}:${account.id}`);
}

function announceAccountSync(provider, result, fallback = false) {
  const sync = (result && result.account_sync) || (fallback
    ? { requested: 1, succeeded: ["local"], failed: [] }
    : null);
  if (!sync || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("agent-account-sync", {
    detail: { provider, sync },
  }));
}

function readStoredAccount(selectionKey) {
  try { return localStorage.getItem(selectionKey) || "default"; } catch { return "default"; }
}

export function useAgentAccounts(provider, quotaAccounts = [], sync = true) {
  const definition = AGENT_ACCOUNTS[provider];
  const selectionKey = agentAccountSelectionKey(provider);
  const viewKey = agentAccountViewKey(provider);
  const [registry, setRegistry] = useState([]);
  const [active, setActive] = useState(() => readStoredAccount(selectionKey));
  // 查看账号（仅决定卡片显示谁的额度）与生效账号分离：
  // 下拉只改 view，真正的切换由"使用"按钮触发 set-active
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(viewKey) || ""; } catch { return ""; }
  });
  const [defaultRemoved, setDefaultRemoved] = useState(false);
  const [launcherInstalled, setLauncherInstalled] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [switching, setSwitching] = useState(false);
  const activeRef = useRef(active);
  const switchingRef = useRef(false);

  const commitActive = useCallback((id) => {
    activeRef.current = id;
    setActive(id);
    try {
      if (id) localStorage.setItem(selectionKey, id);
      else localStorage.removeItem(selectionKey);
    } catch {}
  }, [selectionKey]);

  const applyPayload = useCallback((payload) => {
    const accounts = Array.isArray(payload && payload.accounts) ? payload.accounts : [];
    setRegistry(accounts);
    setDefaultRemoved(Boolean(payload && payload.default_removed));
    setLauncherInstalled(Boolean(payload && payload.launcher_installed));
    if (payload && (typeof payload.active === "string" || payload.active === null)) {
      commitActive(payload.active);
    }
    setReady(true);
    setError("");
  }, [commitActive]);

  const reload = useCallback(async () => {
    const result = await window.api.getAgentAccounts(provider);
    if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
    applyPayload(result);
    return result;
  }, [applyPayload, provider]);

  useEffect(() => {
    if (!sync) {
      setError("");
      return undefined;
    }
    let cancelled = false;
    reload().catch((err) => {
      if (!cancelled) setError(String(err && (err.message || err) || err));
    });
    const off = window.api.onAgentAccountsUpdate
      ? window.api.onAgentAccountsUpdate((payload) => {
        if (!cancelled && (!payload.provider || payload.provider === provider)) applyPayload(payload);
      })
      : null;
    return () => {
      cancelled = true;
      if (off) off();
    };
  }, [reload, applyPayload, provider, sync]);

  const accounts = useMemo(() => {
    const quotas = (quotaAccounts || []).filter((account) => account.provider === definition.quotaProvider);
    if (!sync) return quotas;
    const merged = registry.map((account, index) => {
      const id = agentAccountId(account, index);
      const quota = quotas.find((item, quotaIndex) => agentAccountId(item, quotaIndex) === id);
      return {
        ...(quota || {}),
        ...account,
        provider: definition.quotaProvider,
        account_id: id,
        account_label: agentAccountLabel(account),
        windows: quota && Array.isArray(quota.windows) ? quota.windows : [],
      };
    });
    const registered = new Set(registry.map((account, index) => agentAccountId(account, index)));
    if (!ready) {
      for (const [index, quota] of quotas.entries()) {
        const id = agentAccountId(quota, index);
        if (registered.has(id) || (defaultRemoved && id === "default")) continue;
        merged.push({
          ...quota,
          account_id: id,
          account_label: agentAccountLabel(quota),
        });
      }
    }
    return merged;
  }, [defaultRemoved, definition.quotaProvider, ready, registry, quotaAccounts, sync]);

  const accountIds = accounts.map((account, index) => agentAccountId(account, index));
  const activeId = accountIds.length === 0 ? null : accountIds.includes(active) ? active : accountIds[0];
  const viewId = accountIds.length === 0 ? null : accountIds.includes(view) ? view : activeId;

  const viewAccount = useCallback((id) => {
    setView(id);
    try { if (id) localStorage.setItem(viewKey, id); } catch {}
  }, [viewKey]);

  const dismissNotice = useCallback(() => setNotice(""), []);

  const selectAccount = useCallback(async (id) => {
    if (!sync) {
      setError("");
      setNotice("");
      commitActive(id);
      const result = { ok: true, account_sync: { requested: 1, succeeded: ["local"], failed: [] } };
      announceAccountSync(provider, result);
      return result;
    }
    if (switchingRef.current) return false;
    const previous = activeRef.current;
    switchingRef.current = true;
    setSwitching(true);
    setError("");
    setNotice("");
    commitActive(id);
    try {
      const result = await window.api.updateAgentAccounts(provider, { action: "set-active", id });
      if (!result || !result.ok) throw new Error((result && result.error) || t("state.unknownError"));
      announceAccountSync(provider, result, true);
      applyPayload(result);
      // 长驻 Codex 会话不会热切换：检测到时提示用户重启会话
      const running = Array.isArray(result.running_clients) ? result.running_clients : [];
      setNotice(running.length ? t("dash.accountRestartClients") : "");
      return result;
    } catch (err) {
      commitActive(previous);
      setError(String(err && (err.message || err) || err));
      return { ok: false, error: String(err && (err.message || err) || err) };
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [applyPayload, commitActive, provider, sync]);

  const updateAccounts = useCallback(async (values) => {
    const result = await window.api.updateAgentAccounts(provider, values);
    if (result && result.ok) applyPayload(result);
    return result;
  }, [applyPayload, provider]);

  return {
    accounts,
    registry,
    activeId,
    viewId,
    viewAccount,
    selectAccount,
    updateAccounts,
    reload,
    error,
    notice,
    dismissNotice,
    switching,
    defaultRemoved: sync && defaultRemoved,
    launcherInstalled,
    ready,
  };
}

export function useAgentAccountStates(quotaAccounts, sync = true) {
  const kimi = useAgentAccounts("kimi", quotaAccounts, sync);
  const codex = useAgentAccounts("codex", quotaAccounts, sync);
  const glm = useAgentAccounts("glm", quotaAccounts, sync);
  const deepseek = useAgentAccounts("deepseek", quotaAccounts, sync);
  return { kimi, codex, glm, deepseek };
}
