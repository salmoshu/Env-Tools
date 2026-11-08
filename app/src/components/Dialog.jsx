import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.js";
import MessageIcon from "./MessageIcon.jsx";

// 两种确认弹框共用布局、焦点约束和关闭行为，浮层始终挂在页面滚动容器之外。
export default function Dialog({ title, description, kind = "info", onClose, children, actions }) {
  const id = useId();
  const dialog = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const previous = document.activeElement;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    const focusable = () => [...dialog.current.querySelectorAll("button:not(:disabled), [href], input:not(:disabled), [tabindex='0']")];
    (dialog.current.querySelector("[data-autofocus]") || focusable()[0] || dialog.current).focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current?.();
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0] || dialog.current;
        const last = items[items.length - 1] || dialog.current;
        if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (root) root.inert = wasInert;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div className="overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div ref={dialog} className={`dialog ${kind}`} role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}>
        <div className="dialog-heading">
          <span className="dialog-icon"><MessageIcon kind={kind} size={22} /></span>
          <div id={`${id}-title`} className="dialog-title">{title}</div>
          <button type="button" className="dialog-close" aria-label={t("notice.close")} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        {children ? <div className="dialog-content">{children}</div> : null}
        {description ? <div id={`${id}-description`} className="dialog-msg">{description}</div> : null}
        <div className="dialog-btns">{actions}</div>
      </div>
    </div>, document.body,
  );
}
