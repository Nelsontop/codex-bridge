import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopBridge", {
  loadConfig() {
    return ipcRenderer.invoke("desktop:config:load");
  },
  saveConfig(payload) {
    return ipcRenderer.invoke("desktop:config:save", payload);
  },
  startService() {
    return ipcRenderer.invoke("desktop:service:start");
  },
  stopService() {
    return ipcRenderer.invoke("desktop:service:stop");
  },
  getServiceStatus() {
    return ipcRenderer.invoke("desktop:service:status");
  }
});
