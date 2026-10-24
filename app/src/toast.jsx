// 全局消息提醒（v0.7.42）：所有结果性反馈统一为顶部向下滑出的框提醒。
// 用法：任意组件 import { showToast } from "../toast.js"; showToast(text, "ok"|"error"|"info")
// App 根部渲染 <ToastStack />，多条堆叠、4s 自动消失、互不阻塞。

import { useEffect, useState } from "react";

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
  useEffect(() => {
    const onToast = (item) => {
      setItems((prev) => [...prev.slice(-4), item]);
      setTimeout(() => {
        setItems((prev) => prev.filter((toast) => toast.id !== item.id));
      }, item.ttl);
    };
    listeners.add(onToast);
    return () => listeners.delete(onToast);
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="app-toasts" role="status" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={`app-toast ${toast.kind}`}>{toast.text}</div>
      ))}
    </div>
  );
}
