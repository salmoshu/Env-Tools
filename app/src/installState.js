// 安装/升级运行状态的全局单例 store（v0.7.12）。
// 此前运行状态与日志散落在各组件的 useState 里：切页即丢——升级进行中
// 切到组件管理会看到空面板、卡片上的"升级中…"也消失。这里把状态提升到
// 模块级：一次订阅常驻，切页后回来状态和日志都还在。
//
// v0.7.44：runs 支持并发——同一时刻可有多个组件在安装；running 仍保留
// （最近一场 run），看板角标/结果提示沿用旧口径。日志行带 runKey 与组件
// 标签，组件管理页可按组件过滤，避免多场安装的输出混在一起。

import { useEffect, useState } from "react";

const UPGRADE_COMPONENTS = {
  "Kimi Code": "kimi",
  "OpenAI Codex": "codex",
};

let listeners = new Set();
let state = {
  running: null, // 最近一场 run：{ key, label, kind, components, targets } | null
  runs: {}, // key → run（在跑的所有安装/升级）
  result: null, // { ok, error } | null
  log: [], // 最近 300 行：{ key, label, line }
};
// runKey → 展示名：run 结束后日志仍要能按组件名过滤
const runLabels = {};

function notify() {
  for (const fn of listeners) fn();
}

function runKeyOf(running) {
  if (running.key) return running.key;
  if (running.component) return `component:${running.component}`;
  return `upgrade:${(running.targets || []).join(",")}`;
}

function componentsOf(running) {
  if (Array.isArray(running.components) && running.components.length) return running.components;
  if (running.component) return [running.component];
  return (running.targets || []).map((p) => UPGRADE_COMPONENTS[p]).filter(Boolean);
}

function normalizeRun(running) {
  const key = runKeyOf(running);
  const run = { ...running, key, components: componentsOf(running) };
  runLabels[key] = run.label || key;
  return run;
}

function upsertRun(running) {
  const run = normalizeRun(running);
  state = {
    ...state,
    running: run,
    runs: { ...state.runs, [run.key]: run },
    result: null,
  };
  notify();
  return run;
}

function finishRun(key, result) {
  const runs = { ...state.runs };
  if (key) delete runs[key];
  const remaining = Object.values(runs);
  const current = state.running;
  state = {
    ...state,
    runs,
    running: key && current && current.key !== key ? current : remaining[remaining.length - 1] || null,
    result: result || state.result,
  };
  notify();
}

// 主进程广播常驻订阅：模块加载即开始，与组件生命周期无关。
// start/end 让所有窗口（看板、悬浮小球、组件管理）共享同一份运行状态。
window.api.onInstallProgress((payload) => {
  if (!payload) return;
  const { key, line, start, end } = payload;
  if (start) {
    upsertRun({ ...start, key });
    return;
  }
  if (end) {
    finishRun(key, { ok: Boolean(end.ok), error: end.error || null });
    return;
  }
  if (!line) return;
  const label = (state.runs[key] && state.runs[key].label) || runLabels[key] || key || "";
  state = { ...state, log: [...state.log.slice(-299), { key: key || "", label, line }] };
  notify();
});

export function getInstallState() {
  return state;
}

export function subscribeInstallState(notifyFn) {
  listeners.add(notifyFn);
  return () => listeners.delete(notifyFn);
}

export function setInstallRunning(running) {
  if (!running) {
    state = { ...state, running: null };
    notify();
    return null;
  }
  return upsertRun(running);
}

export function setInstallResult(result, run) {
  finishRun(run && run.key, result);
}

export function dismissInstallResult() {
  state = { ...state, result: null };
  notify();
}

export function clearInstallLog() {
  state = { ...state, log: [], result: null };
  notify();
}

/** 正在安装的组件 key 集合（看板升级与组件管理共用同一套 run） */
export function busyComponents(install) {
  const busy = new Set();
  for (const run of Object.values((install && install.runs) || {})) {
    for (const component of run.components || []) busy.add(component);
  }
  return busy;
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
