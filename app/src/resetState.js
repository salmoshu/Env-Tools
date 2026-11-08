// 重置状态独立于按钮和配额卡：关闭 hint、切页或刷新移除卡片时，任务仍然可见。
import { useSyncExternalStore } from "react";
import { t } from "./i18n.js";
import { showToast, updateToast } from "./toast.jsx";

let state = { confirmation: null, pending: {} };
const listeners = new Set();
const subscribe = (notify) => { listeners.add(notify); return () => listeners.delete(notify); };
const snapshot = () => state;
function update(next) {
  state = { ...state, ...next };
  for (const notify of listeners) notify();
}
export const resetKey = ({ provider, accountId }) => `${provider}:${accountId || "default"}`;
export const useResetState = () => useSyncExternalStore(subscribe, snapshot);

export function requestReset(target) {
  if (state.pending[resetKey(target)] || state.confirmation) return false;
  update({ confirmation: target });
  return true;
}

export function cancelReset() {
  update({ confirmation: null });
}

export async function confirmReset() {
  const target = state.confirmation;
  if (!target) return;
  const key = resetKey(target);
  if (state.pending[key]) return;
  // 先关闭确认框、锁住同一账号的全部入口，再发起 IPC。
  update({ confirmation: null, pending: { ...state.pending, [key]: true } });
  const title = `${target.provider === "codex" ? "OpenAI Codex" : "GLM"} · ${target.accountLabel || target.accountId || "default"}`;
  const progress = showToast(`${target.what} · ${t("dash.resetting")}`, "pending", 0, { title });
  let message;
  let kind = "ok";
  try {
    const result = await window.api.quotaReset(target.provider, target.resetType, target.accountId);
    if (!result?.ok) throw new Error(result?.error || t("dash.resetFailed"));
    const data = result.data || {};
    if (target.provider === "codex") {
      const code = data.code || "";
      const messageKey = {
        reset: "dash.resetOk", nothing_to_reset: "dash.resetNothing",
        no_credit: "dash.resetNoCredit", already_redeemed: "dash.resetAlready",
      }[code];
      message = messageKey ? t(messageKey) : t("dash.resetFailed");
      kind = code === "reset" ? "ok" : code === "nothing_to_reset" ? "info" : "error";
      if (code === "reset" && data.windows_reset) {
        message += ` · ${t("dash.resetWindows").replace("{n}", String(data.windows_reset))}`;
      }
    } else {
      message = t("dash.resetOk");
    }
  } catch (error) {
    kind = "error";
    message = `${t("dash.resetFailed")}: ${String(error?.message || error)}`;
  } finally {
    const pending = { ...state.pending };
    delete pending[key];
    update({ pending });
  }
  updateToast(progress, `${target.what} · ${message}`, kind, kind === "ok" ? 5000 : 10000, { title });
}
