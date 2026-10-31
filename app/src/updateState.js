// 应用自更新 UI 状态的全局单例 store（v0.7.49）。
// 此前 UpdateSection 用组件内 useState：退出设置页即卸载，下载仍在主进程
// 进行，回来后 busy/progress 全丢——既不显示下载中，也不显示完成或报错。
// 现在状态提升到模块级：切页后回来仍是同一份，进度事件在模块加载时订阅。

import { useEffect, useState } from "react";

let listeners = new Set();
let state = {
  busy: false,
  progress: null, // { phase, percent|null }
  status: { text: "", available: false },
};

function notify() {
  for (const fn of listeners) fn();
}

window.api.onUpdateProgress(({ phase, percent }) => {
  state = { ...state, progress: { phase, percent: percent == null ? null : percent } };
  notify();
});

export function setUpdateBusy(busy) {
  state = { ...state, busy };
  notify();
}

export function setUpdateProgress(progress) {
  state = { ...state, progress };
  notify();
}

export function setUpdateStatus(status) {
  state = { ...state, status };
  notify();
}

export function useUpdateState() {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    setCurrent(state);
    const fn = () => setCurrent(state);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return current;
}
