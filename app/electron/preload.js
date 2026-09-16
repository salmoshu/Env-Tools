const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // 数据与刷新
  onUsageUpdate: (callback) =>
    ipcRenderer.on("usage-update", (_event, payload) => callback(payload)),
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
  onOpenSettings: (callback) => ipcRenderer.on("open-settings", () => callback()),
  onNavigate: (callback) => ipcRenderer.on("navigate", (_event, route) => callback(route)),
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
  onInstallProgress: (callback) =>
    ipcRenderer.on("install-progress", (_event, payload) => callback(payload)),
  componentStatus: (component, environment) =>
    ipcRenderer.invoke("component-status", component, environment),
});
