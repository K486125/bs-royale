// 로비/방 화면(렌더러)에서 배경음악 재생을 트리거할 수 있게 안전한 통로만 열어준다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bsApi", {
  startMusic: () => ipcRenderer.send("start-music"),
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_event, status) => callback(status))
});
