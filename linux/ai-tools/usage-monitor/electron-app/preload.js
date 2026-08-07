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
});
