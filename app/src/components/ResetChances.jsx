import { t } from "../i18n.js";
import { nearQuotaLimit, QUOTA_RESET_THRESHOLD, windowUsagePct } from "../utils.js";
import ResetButton from "./ResetButton.jsx";
import ResetChancesText from "./ResetChancesText.jsx";

// 主窗口和悬浮看板共用同一份次数、hint 入口及外层按钮门槛。
export default function ResetChances({ account }) {
  const credits = account.rate_limit_reset_credits;
  const cards = account.reset_cards;
  const parts = [];
  const actions = [];
  let stale = Boolean(account.stale);
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
  return (
    <div className="limit-resets">
      <ResetChancesText account={account} renderActions={(close) => <>
        <div className="reset-expiry-actions">{actions.map((action) => button(action, close))}</div>
        {stale ? <div className="reset-expiry-note">{t("dash.resetStaleHint")}</div> : null}
      </>}>
        {t("dash.resetChances")}: {parts.join(" · ")}
      </ResetChancesText>
      {actions.filter((action) => action.available && action.urgent && !stale).map((action) => button(action))}
    </div>
  );
}
