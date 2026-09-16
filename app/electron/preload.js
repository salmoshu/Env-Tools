const { contextBridge, ipcRenderer } = require("electron");

// 订阅类 API 统一返回取消函数：渲染层 effect cleanup 直接调用即可
// （ipcRenderer.on 本身返回 EventEmitter，不是 off，曾导致切换页面时
// “off is not a function” 把 React 树打崩白屏）。
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("api", {
  // 数据与刷新
  onUsageUpdate: (callback) => subscribe("usage-update", callback),
  getUsage: (target) => ipcRenderer.invoke("get-usage", target),
  updateCheck: () => ipcRenderer.invoke("update-check"),
  updateInstall: () => ipcRenderer.invoke("update-install"),
  updateSetToken: (token) => ipcRenderer.invoke("update-set-token", token),
  onUpdateProgress: (callback) => subscribe("update-progress", (payload) => callback(payload)),
  onNavigate: (callback) => subscribe("navigate", (_payload, route) => callback(route)),
  onOpenSettings: (callback) => subscribe("open-settings", () => callback()),
  onInstallProgress: (callback) => subscribe("install-progress", (payload) => callback(payload)),
  refresh: () => ipcRenderer.send("refresh"),
  getAnalytics: (days, agent, target) => ipcRenderer.invoke("get-analytics", days, agent, target),
  getBackendStatus: () => ipcRenderer.invoke("get-backend-status"),
  listTargets: () => ipcRenderer.invoke("list-targets"),
  connectTarget: (targetId) => ipcRenderer.invoke("connect-target", targetId),
  sshList: () => ipcRenderer.invoke("ssh-list"),
  sshSave: (list) => ipcRenderer.invoke("ssh-save", list),
  sshConnect: (host) => ipcRenderer.invoke("ssh-connect", host),
  sshDisconnect: (host) => ipcRenderer.invoke("ssh-disconnect", host),
  // 窗口
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),
  togglePin: () => ipcRenderer.invoke("toggle-pin"),
  getPinState: () => ipcRenderer.invoke("get-pin-state"),
  fitHeight: (height) => ipcRenderer.send("fit-height", height),
  resetFit: () => ipcRenderer.send("reset-fit"),
  openUsageBoard: () => ipcRenderer.invoke("open-usage-board"),
  openFullDashboard: () => ipcRenderer.invoke("open-full-dashboard"),
  openTools: () => ipcRenderer.invoke("open-tools"),
  openBoardSettings: () => ipcRenderer.invoke("open-board-settings"),
  settingsOpen: (open) => ipcRenderer.send("settings-open", open),
  // 设置
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (values) => ipcRenderer.invoke("set-settings", values),
  getApiKeyStatus: () => ipcRenderer.invoke("api-key-status"),
  saveApiKeys: (values) => ipcRenderer.invoke("save-api-keys", values),
  loginAgent: (agent, environment) => ipcRenderer.invoke("login-agent", agent, environment),
  // 安装 / 升级（看板版本徽章升级与 Tools 组件共用运行器）
  upgrade: (targets, environment, windowsSetupScript) =>
    ipcRenderer.invoke("upgrade-agents", targets, environment, windowsSetupScript),
  runComponent: (component, environment, windowsSetupScript) =>
    ipcRenderer.invoke("run-component", component, environment, windowsSetupScript),
  cancelInstall: () => ipcRenderer.invoke("install-cancel"),
  componentStatus: (component, environment) =>
    ipcRenderer.invoke("component-status", component, environment),
});
