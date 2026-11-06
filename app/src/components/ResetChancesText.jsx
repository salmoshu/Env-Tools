import { t } from "../i18n.js";
import { resetExpiries } from "../resetExpiries.js";

const pad = (n) => String(n).padStart(2, "0");
function dateText(at, full = false) {
  const d = new Date(at * 1000);
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return full ? `${d.getFullYear()}-${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : date;
}

export default function ResetChancesText({ account, children }) {
  const entries = resetExpiries(account);
  const earliest = entries.find((entry) => entry.at != null);
  const hint = entries.length ? [
    t("dash.resetExpiryHint"),
    ...entries.map((entry, i) => `${i + 1}. ${entry.label ? entry.label + " · " : ""}${entry.at == null
      ? t(entry.noExpiry ? "dash.resetExpiryNever" : "dash.resetExpiryUnknown") : dateText(entry.at, true)}`),
  ].join("\n") : undefined;
  return (
    <span className="reset-chances-text" title={hint}>
      {children}
      {earliest ? ` · ${t("dash.resetChancesEarliest")} ${dateText(earliest.at)}` : ""}
    </span>
  );
}
