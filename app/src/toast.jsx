// 全局消息提醒：所有结果性反馈统一从右下角向左滑入。
// 用法：任意组件 import { showToast } from "../toast.js"; showToast(text, "ok"|"error"|"info")
// App 根部渲染 <ToastStack />，多条堆叠、4s 自动消失，也可手动关闭。

import { useCallback, useEffect, useRef, useState } from "react";

const listeners = new Set();
let seq = 0;

export function showToast(text, kind = "info", ttl = 4000) {
  const message = String(text || "").trim();
  if (!message) return;
  const id = ++seq;
  for (const emit of listeners) emit({ id, text: message, kind, ttl });
}

export function ToastStack() {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());
  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    const onToast = (item) => {
      setItems((prev) => [...prev.slice(-4), item]);
      const timer = setTimeout(() => dismiss(item.id), item.ttl);
      timers.current.set(item.id, timer);
    };
    listeners.add(onToast);
    const activeTimers = timers.current;
    return () => {
      listeners.delete(onToast);
      for (const timer of activeTimers.values()) clearTimeout(timer);
      activeTimers.clear();
    };
  }, [dismiss]);

  if (items.length === 0) return null;
  return (
    <div className="app-toasts" role="status" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={`app-toast ${toast.kind}`}>
          <span className="app-toast-text">{toast.text}</span>
          <button type="button" className="toast-close" aria-label="close" onClick={() => dismiss(toast.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
