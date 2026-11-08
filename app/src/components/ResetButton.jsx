import { t } from "../i18n.js";
import { cancelReset, confirmReset, requestReset, resetKey, useResetState } from "../resetState.js";
import Dialog from "./Dialog.jsx";

/**
 * 配额重置按钮（GLM 5h/7d 重置卡、Codex 速率限制重置额度）。
 * 外层按钮的 80% 门槛由配额行控制，hint 中的按钮始终存在；
 * 两者共用确认与任务状态，确认后立即关闭弹框，右侧常驻状态直到任务结束。
 */
export default function ResetButton({ provider, resetType = null, accountId = "default", accountLabel, what, disabled = false, onRequest, children }) {
  const state = useResetState();
  const target = { provider, resetType, accountId, accountLabel, what };
  const pending = Boolean(state.pending[resetKey(target)]);
  return (
    <button type="button" className="reset-action-btn" disabled={disabled || pending} aria-busy={pending}
      onClick={() => { if (requestReset(target)) onRequest?.(); }}>
      {children}
    </button>
  );
}

// 挂在 App 根部，hint 关闭或卡片更新不会卸载确认框。
export function ResetConfirmation() {
  const { confirmation } = useResetState();
  if (!confirmation) return null;
  return (
    <Dialog title={t("dash.resetDlgTitle")} kind="reset" onClose={cancelReset}
      description={t("dash.resetDlgBody").replace("{what}", confirmation.what || "")}
      actions={<>
        <button type="button" className="ghost" data-autofocus onClick={cancelReset}>{t("dash.resetDlgCancel")}</button>
        <button type="button" onClick={confirmReset}>{t("dash.resetDlgOk")}</button>
      </>}>
      <div className="dialog-context">
        <strong>{confirmation.provider === "codex" ? "OpenAI Codex" : "GLM"}</strong>
        <span>{confirmation.accountLabel || confirmation.accountId || "default"} · {confirmation.what}</span>
      </div>
    </Dialog>
  );
}
