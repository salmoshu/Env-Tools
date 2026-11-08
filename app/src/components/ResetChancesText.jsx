import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.js";
import { resetExpiries } from "../resetExpiries.js";

const pad = (n) => String(n).padStart(2, "0");
function dateText(at, full = false) {
  const d = new Date(at * 1000);
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return full ? `${d.getFullYear()}-${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : date;
}

export default function ResetChancesText({ account, children, renderActions }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const anchor = useRef(null);
  const popup = useRef(null);
  const timer = useRef(null);
  const id = useId();
  const entries = resetExpiries(account);
  const earliest = entries.find((entry) => entry.at != null);
  const show = (immediate = false) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), immediate ? 0 : 160);
  };
  const hide = (immediate = false) => {
    clearTimeout(timer.current);
    const close = () => {
      if (!immediate && popup.current?.contains(document.activeElement)) return;
      setOpen(false); setPosition(null);
    };
    if (immediate) close();
    else timer.current = setTimeout(close, 180);
  };
  const blur = (event) => {
    if (!anchor.current?.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) hide();
  };
  const focusAction = () => {
    show(true);
    requestAnimationFrame(() => popup.current?.querySelector("button:not(:disabled)")?.focus());
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !popup.current || !anchor.current) return undefined;
    const place = () => {
      const rect = anchor.current.getBoundingClientRect();
      const hint = popup.current.getBoundingClientRect();
      const above = rect.bottom + hint.height + 20 > window.innerHeight && rect.top > hint.height + 8;
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - hint.width - 12));
      const top = Math.max(12, Math.min(above ? rect.top - hint.height - 8 : rect.bottom + 8,
        window.innerHeight - hint.height - 12));
      setPosition((prev) => prev?.left === left && prev?.top === top ? prev : { left, top });
    };
    const onKey = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        anchor.current?.focus({ preventScroll: true });
        hide(true);
      }
    };
    const onOutside = (event) => {
      if (!popup.current?.contains(event.target) && !anchor.current?.contains(event.target)) hide(true);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [open, entries.length]);
  return (
    <>
      <button
        type="button"
        ref={anchor}
        className="reset-chances-text"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onMouseEnter={() => show()}
        onMouseLeave={() => hide()}
        onFocus={() => show(true)}
        onBlur={blur}
        onClick={(event) => { if (event.detail === 0) focusAction(); else show(true); }}
        onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); focusAction(); } }}
      >
        {children}
        {earliest ? ` · ${t("dash.resetChancesEarliest")} ${dateText(earliest.at)}` : ""}
      </button>
      {open ? createPortal(
        <div
          ref={popup} id={id} role="dialog" aria-labelledby={`${id}-title`} className="reset-expiry-tooltip"
          style={position || { visibility: "hidden", left: 0, top: 0 }}
          onMouseEnter={() => { clearTimeout(timer.current); }}
          onMouseLeave={() => hide()}
          onFocus={() => { clearTimeout(timer.current); }}
          onBlur={blur}
        >
          <div className="reset-expiry-heading">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <rect x="4" y="5" width="16" height="16" rx="3" />
              <path d="M8 3v4m8-4v4M4 11h16" />
            </svg>
            <span id={`${id}-title`}>{t("dash.resetExpiryTitle")}</span>
          </div>
          <div className="reset-expiry-meta">{t("dash.resetExpiryMeta").replace("{n}", String(entries.length))}</div>
          <div className="reset-expiry-list">
            {!entries.length ? <div className="reset-expiry-empty">{t("dash.resetExpiryEmpty")}</div> : null}
            {entries.map((entry, index) => (
              <div className="reset-expiry-row" key={index}>
                <span className="reset-expiry-label">{entry.label || pad(index + 1)}</span>
                {entry.at == null ? (
                  <span className="reset-expiry-unknown">{t(entry.noExpiry ? "dash.resetExpiryNever" : "dash.resetExpiryUnknown")}</span>
                ) : (
                  <span className="reset-expiry-date">
                    {dateText(entry.at, true).split(" ")[0]}
                    <span>{dateText(entry.at, true).split(" ")[1]}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
          {renderActions ? <div className="reset-expiry-footer">{renderActions(() => {
            anchor.current?.focus({ preventScroll: true });
            hide(true);
          })}</div> : null}
        </div>, document.body,
      ) : null}
    </>
  );
}
