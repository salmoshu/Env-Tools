const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onUsageUpdate: (callback) =>
    ipcRenderer.on("usage-update", (_event, payload) => callback(payload)),
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),
  refresh: () => ipcRenderer.send("refresh"),
  fitHeight: (height) => ipcRenderer.send("fit-height", height),
  togglePin: () => ipcRenderer.invoke("toggle-pin"),
  getPinState: () => ipcRenderer.invoke("get-pin-state"),
  resetFit: () => ipcRenderer.send("reset-fit"),
  upgrade: (targets, environment, windowsSetupScript) =>
    ipcRenderer.invoke("upgrade-agents", targets, environment, windowsSetupScript),
  onUpgradeProgress: (callback) =>
    ipcRenderer.on("upgrade-progress", (_event, payload) => callback(payload)),
  cancelUpgrade: () => ipcRenderer.invoke("upgrade-cancel"),
  getApiKeyStatus: () => ipcRenderer.invoke("api-key-status"),
  saveApiKeys: (values) => ipcRenderer.invoke("save-api-keys", values),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (values) => ipcRenderer.invoke("set-settings", values),
  loginAgent: (agent, environment) => ipcRenderer.invoke("login-agent", agent, environment),
  settingsOpen: (open) => ipcRenderer.send("settings-open", open),
  // v0.2.0 双窗口：全量模式（默认）⇄ 用量看板（小悬浮窗），设置页住在看板窗口
  openUsageBoard: () => ipcRenderer.invoke("open-usage-board"),
  openFullDashboard: () => ipcRenderer.invoke("open-full-dashboard"),
  openBoardSettings: () => ipcRenderer.invoke("open-board-settings"),
  getAnalytics: (days) => ipcRenderer.invoke("get-analytics", days),
  onOpenSettings: (callback) => ipcRenderer.on("open-settings", () => callback()),
});
