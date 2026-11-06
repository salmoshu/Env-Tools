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

function componentsOf(running) {
  if (Array.isArray(running.components) && running.components.length) return running.components;
  if (running.component) return [running.component];
  return (running.targets || []).map((p) => UPGRADE_COMPONENTS[p]).filter(Boolean);
}

function normalizeRun(running) {
  const key = running.key;
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

// 下载进度行（心跳式百分比）折叠为同一行更新，不再逐条追加撑满日志面板
function isProgressLine(line) {
  return /下载中|下载进度|download(ing)?\s*[:：]|\b[KMGT]iB\b|KiB\/s|MiB\/s/i.test(line)
    && /%|进度|progress/i.test(line);
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
  const progress = isProgressLine(line);
  const log = state.log.slice(-299);
  const last = log[log.length - 1];
  if (progress && last && last.key === (key || "") && last.progress) {
    // 同一组件的连续进度行：替换上一行而不是追加
    log[log.length - 1] = { key: key || "", label, line, progress: true };
  } else {
    log.push({ key: key || "", label, line, progress });
  }
  state = { ...state, log };
  notify();
});

export function getInstallState() {
  return state;
}

export function subscribeInstallState(notifyFn) {
  listeners.add(notifyFn);
  return () => listeners.delete(notifyFn);
}

// 运行记录只由主进程的 start/end 广播维护，避免乐观记录与发行版回退后
// 的真实 runKey 不同，留下永不结束的任务。IPC 结果也覆盖启动前失败。
export function setInstallResult(result) {
  state = { ...state, result };
  notify();
}

export function dismissInstallResult() {
  state = { ...state, result: null };
  notify();
}

export function clearInstallLog() {
  state = { ...state, log: [], result: null };
  notify();
}

/** 当前平台/发行版正在安装的组件（看板升级与组件管理共用）。 */
export function busyComponents(install, environment, distro = "") {
  const busy = new Set();
  for (const run of Object.values((install && install.runs) || {})) {
    if (run.environment !== environment) continue;
    if (environment === "wsl" && distro && run.distro !== distro) continue;
    for (const component of run.components || []) busy.add(component);
  }
  return busy;
}

export function upgradingTargets(install, data = {}) {
  data = data || {};
  const environment = ["windows", "wsl"].includes(data.environment)
    ? data.environment : data.native_environment || "windows";
  const busy = busyComponents(install, environment, data.wsl_distro || "");
  return Object.keys(UPGRADE_COMPONENTS).filter((provider) => busy.has(UPGRADE_COMPONENTS[provider]));
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
