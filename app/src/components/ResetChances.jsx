import { useState } from "react";
import { t } from "../i18n.js";
import { showToast } from "../toast.jsx";
import { nearQuotaLimit, QUOTA_RESET_THRESHOLD, windowUsagePct } from "../utils.js";
import ResetButton from "./ResetButton.jsx";
import ResetChancesText from "./ResetChancesText.jsx";

// 主窗口和悬浮看板共用同一份次数、hint 入口及外层按钮门槛。
export default function ResetChances({ account }) {
  const [reauthBusy, setReauthBusy] = useState(false);
  const credits = account.rate_limit_reset_credits;
  const cards = account.reset_cards;
  const parts = [];
  const actions = [];
  let stale = Boolean(account.stale);
  const credStatus = cards && cards.credential_status;
  const credExpired = Boolean(credStatus && credStatus.expired);
  const cacheExpired = Boolean(cards && cards.cache_expired);
  const cacheAgeH = cards && cards.cache_age_hours != null ? Math.round(cards.cache_age_hours) : null;
  if (credits && typeof credits === "object") {
    const available = credits.available_count;
    const applicable = credits.applicable_available_count;
    if (available == null && applicable == null) return null;
    if (available != null) parts.push(t("dash.resetRemaining").replace("{n}", String(available)));
    if (applicable != null) parts.push(t(Number(applicable) > 0 ? "dash.resetUsableNow" : "dash.resetAfterLimit"));
    actions.push({ provider: "codex", what: t("dash.resetWhatCodex"), label: t("dash.resetNow"),
      available: Number(available) > 0, urgent: nearQuotaLimit(account) });
  } else if (cards && typeof cards === "object") {
    stale = stale || Boolean(cards.stale);
    for (const [key, type, window] of [["five_hour", "FIVE_HOUR", "5h"], ["week", "WEEK", "7d"]]) {
      const count = Array.isArray(cards[key]) ? cards[key].length : 0;
      if (count) parts.push(`${window} ×${count}`);
      actions.push({ provider: "glm", resetType: type, what: t(`dash.resetWhat${window}`), label: t(`dash.resetUse${window}`),
        available: count > 0, urgent: windowUsagePct(account, window) >= QUOTA_RESET_THRESHOLD });
    }
    if (!parts.length) parts.push(t("dash.resetRemaining").replace("{n}", "0"));
  } else return null;
  const button = (action, close) => (
    <ResetButton key={action.resetType || action.provider} provider={action.provider} resetType={action.resetType}
      accountId={account.account_id || "default"} accountLabel={account.account_label} what={action.what}
      disabled={!action.available || stale} onRequest={close}>{action.label}</ResetButton>
  );
  const reauth = async () => {
    if (reauthBusy) return;
    setReauthBusy(true);
    try {
      const result = await window.api?.openZcode?.();
      if (!result?.ok) throw new Error(result?.error || "unavailable");
      showToast(t("dash.credReauthOpened"), "info", 8000);
    } catch (error) {
      showToast(`${t("dash.credReauthFailed")}: ${error.message || error}`, "error", 6000);
    } finally {
      setReauthBusy(false);
    }
  };
  return (
    <div className="limit-resets">
      {credExpired && (
        <div className="cred-expired-warning">
          <span>{t(credStatus.server_rejected ? "dash.credRejected" : "dash.credExpired")}{credStatus.exp_human ? `（${credStatus.exp_human}）` : ""}</span>
          {credStatus.can_open_client === false ? (
            <span>{t("dash.credRebind")}</span>
          ) : (
            <button type="button" className="cred-reauth-btn" disabled={reauthBusy} onClick={reauth}>
              {t(reauthBusy ? "dash.credReauthOpening" : "dash.credReauth")}
            </button>
          )}
        </div>
      )}
      {!credExpired && cacheExpired && (
        <div className="cred-expired-warning mild">
          {t("dash.cacheExpired").replace("{h}", String(cacheAgeH ?? "?"))}
        </div>
      )}
      <ResetChancesText account={account} renderActions={(close) => <>
        <div className="reset-expiry-actions">{actions.map((action) => button(action, close))}</div>
        {stale && !credExpired ? <div className="reset-expiry-note">
          {t(cards?.cache_age_unknown ? "dash.resetStaleUnknownHint" : "dash.resetStaleHint")}
        </div> : null}
      </>}>
        {t("dash.resetChances")}: {parts.join(" · ")}
      </ResetChancesText>
      {actions.filter((action) => action.available && action.urgent && !stale).map((action) => button(action))}
    </div>
  );
}
