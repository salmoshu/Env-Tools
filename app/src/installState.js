// 安装/升级运行状态的全局单例 store（v0.7.12）。
// 此前运行状态与日志散落在各组件的 useState 里：切页即丢——升级进行中
// 切到组件管理会看到空面板、卡片上的"升级中…"也消失。这里把状态提升到
// 模块级：一次订阅常驻，切页后回来状态和日志都还在。

import { useEffect, useState } from "react";

let listeners = new Set();
let state = {
  running: null, // { label, kind } | null
  result: null, // { ok, error } | null
  log: [], // 最近 300 行
};

// 主进程广播常驻订阅：模块加载即开始，与组件生命周期无关
window.api.onInstallProgress(({ line }) => {
  if (!line) return;
  state = { ...state, log: [...state.log.slice(-299), line] };
  for (const notify of listeners) notify();
});

export function getInstallState() {
  return state;
}

export function subscribeInstallState(notify) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function setInstallRunning(running) {
  state = { ...state, running, result: running ? null : state.result };
  for (const notify of listeners) notify();
}

export function setInstallResult(result) {
  state = { ...state, result, running: null };
  for (const notify of listeners) notify();
}

export function dismissInstallResult() {
  state = { ...state, result: null };
  for (const notify of listeners) notify();
}

export function clearInstallLog() {
  state = { ...state, log: [], result: null };
  for (const notify of listeners) notify();
}

/** React 绑定：安装状态变化时触发重渲染 */
export function useInstallState() {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    setCurrent(state);
    return subscribeInstallState(() => setCurrent(state));
  }, []);
  return current;
}
