// 숨김 배경음악 창(audio.html)이 쓰는 통로.
// 이 창에 Node 권한을 통째로 열어주는 대신, 필요한 신호 두 개만 노출한다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bsAudio", {
  onPlay: (callback) => ipcRenderer.on("play-music", () => callback()),
  onSettings: (callback) => ipcRenderer.on("music-settings", (_event, settings) => callback(settings))
});
