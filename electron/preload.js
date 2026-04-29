const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mitmAntigravity", {
  onBackendExit(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("backend-exit", listener);
    return () => ipcRenderer.removeListener("backend-exit", listener);
  },
});
