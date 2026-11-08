// 全局消息提醒与任务状态：任务进行中常驻，完成后在同一张通知卡上显示结果。
import { useSyncExternalStore } from "react";
import { t } from "./i18n.js";
import MessageIcon from "./components/MessageIcon.jsx";

const listeners = new Set();
const timers = new Map();
let items = [];
let seq = 0;
const subscribe = (notify) => { listeners.add(notify); return () => listeners.delete(notify); };
const snapshot = () => items;
const notify = () => { for (const listener of listeners) listener(); };

function dismiss(id) {
  clearTimeout(timers.get(id)?.timer);
  timers.delete(id);
  items = items.filter((item) => item.id !== id);
  notify();
}

function schedule(id, ttl) {
  clearTimeout(timers.get(id)?.timer);
  timers.delete(id);
  if (ttl > 0) timers.set(id, { timer: setTimeout(() => dismiss(id), ttl), remaining: ttl, started: Date.now() });
}

function pause(id) {
  const active = timers.get(id);
  if (!active || !active.timer) return;
  clearTimeout(active.timer);
  active.remaining = Math.max(1, active.remaining - (Date.now() - active.started));
  active.timer = null;
}

function resume(id, element) {
  if (element.matches(":hover") || element.contains(document.activeElement)) return;
  const active = timers.get(id);
  if (active && !active.timer) schedule(id, active.remaining);
}

export function showToast(text, kind = "info", ttl = 4000, options = {}) {
  const message = String(text || "").trim();
  if (!message) return null;
  const id = ++seq;
  items = [...items, { id, text: message, kind, ...options }];
  // 最多保留四条结果提示；运行中的任务不被新通知挤掉。
  const results = items.filter((item) => item.kind !== "pending");
  for (const item of results.slice(0, -4)) dismiss(item.id);
  schedule(id, kind === "pending" ? 0 : ttl);
  notify();
  return id;
}

export function updateToast(id, text, kind = "info", ttl = 4000, options = {}) {
  if (!items.some((item) => item.id === id)) return showToast(text, kind, ttl, options);
  items = items.map((item) => item.id === id ? { ...item, text, kind, ...options } : item);
  schedule(id, kind === "pending" ? 0 : ttl);
  notify();
  return id;
}

export function ToastStack() {
  const current = useSyncExternalStore(subscribe, snapshot);
  if (!current.length) return null;
  return (
    <div className="app-toasts" role="region" aria-label={t("notice.notifications")}>
      {current.map((item) => (
        <div key={item.id} className={`app-toast ${item.kind}`} role={item.kind === "error" ? "alert" : "status"} aria-atomic="true"
          onMouseEnter={() => pause(item.id)} onMouseLeave={(event) => resume(item.id, event.currentTarget)}
          onFocus={() => pause(item.id)} onBlur={(event) => resume(item.id, event.currentTarget)}>
          <span className="app-toast-icon"><MessageIcon kind={item.kind} size={18} /></span>
          <div className="app-toast-content">
            <div className="app-toast-title">{item.title || t(`notice.${item.kind}`)}</div>
            <div className="app-toast-text">{item.text}</div>
          </div>
          {item.kind !== "pending" ? (
            <button type="button" className="toast-close" aria-label={t("notice.close")} onClick={() => dismiss(item.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
