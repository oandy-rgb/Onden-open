// 網頁與桌面外殼之間唯一的橋（desktop/src/aiAnswering/bridge.mjs 的頻道）：只有下面這幾個動作，
// 沒有通用的 invoke／send，網頁拿不到 ipcRenderer。sandbox 的 preload 只能用 CommonJS。
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = {
  detect: "onden:ai:detect",
  status: "onden:ai:status",
  previewAddress: "onden:ai:preview-address",
  enableOwn: "onden:ai:enable-own",
  disableOwn: "onden:ai:disable-own",
  enableRemote: "onden:ai:enable-remote",
  disableRemote: "onden:ai:disable-remote",
  statusChanged: "onden:ai:status-changed",
};

contextBridge.exposeInMainWorld("ondenDesktop", {
  version: 1,
  ai: {
    detect: () => ipcRenderer.invoke(CHANNEL.detect),
    status: () => ipcRenderer.invoke(CHANNEL.status),
    previewAddress: (text) => ipcRenderer.invoke(CHANNEL.previewAddress, text),
    enableOwn: (input) => ipcRenderer.invoke(CHANNEL.enableOwn, input),
    disableOwn: () => ipcRenderer.invoke(CHANNEL.disableOwn),
    enableRemote: (input) => ipcRenderer.invoke(CHANNEL.enableRemote, input),
    disableRemote: () => ipcRenderer.invoke(CHANNEL.disableRemote),
    /** 狀態變了就呼叫 callback；回傳取消訂閱的函式。 */
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on(CHANNEL.statusChanged, listener);
      return () => ipcRenderer.removeListener(CHANNEL.statusChanged, listener);
    },
  },
});
