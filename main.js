const { app, BrowserWindow, session, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PROTOCOL = "bsbattle";

// 배경 영상에 소리가 있는 <video autoplay>가 음소거 없이도 재생되게 허용한다.
// (일반 웹사이트라면 브라우저 정책상 막히지만, 우리 앱이므로 이 제약을 풀어도 안전하다)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// 웹사이트 버튼(<a href="bsbattle://play">)으로 이 앱을 실행할 수 있게 프로토콜을 등록한다.
// 개발 모드(electron .)에서는 실행 경로가 electron.exe라서 별도로 진입점을 지정해줘야 한다.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// 이미 실행 중일 때 웹사이트에서 다시 열려고 하면, 새 창을 또 띄우지 않고 기존 창을 앞으로 가져온다.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg"
};

// ES 모듈(import)은 file:// 에서 CORS 오류가 나기 때문에,
// 앱 안에서 로컬 정적 서버를 띄워 http://localhost 로 로드한다.
// 포트 0 = OS가 비어있는 포트를 알아서 골라줌 (여러 창/프로세스를 동시에 띄워도 충돌 없음).
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(filePath);
        // 코드 파일(html/js/css)은 계속 고치므로 캐시하면 구버전이 뜰 수 있어 no-store.
        // 이미지/영상 같은 정적 리소스는 캐시를 허용해야 카드가 다시 그려질 때마다
        // 매번 새로 받아오면서 깜빡이거나 느려지는 걸 막을 수 있다.
        const isCode = [".html", ".js", ".css"].includes(ext);
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
          "Cache-Control": isCode ? "no-store" : "public, max-age=3600"
        });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const FIXED_WIDTH = 940;
const FIXED_HEIGHT = 600;

// 제목 표시줄 색상 (css의 .titlebar와 같은 값을 써야 이어져 보인다)
const TITLEBAR_COLOR = "#4a4e57";
const TITLEBAR_SYMBOL_COLOR = "#e8eaf0";
const TITLEBAR_HEIGHT = 32;

let audioWin = null;
let visibleWindowCount = 0;
const mainWindows = [];

// 업데이트 확인/다운로드/적용 준비 상태를 열려 있는 모든 창(로비 화면)에 알려서
// 사용자가 "지금 뭐가 되고 있는지" 안심하고 볼 수 있게 한다.
function broadcastUpdateStatus(status) {
  mainWindows.forEach((w) => w.webContents.send("update-status", status));
}

// 배경음악 전용 숨김 창. 로비<->대기실 페이지 이동(location.href)과 무관하게
// 계속 떠 있으므로, 새로고침/화면 전환 때마다 음악이 처음부터 다시 켜지지 않는다.
function createAudioWindow(port) {
  audioWin = new BrowserWindow({
    show: false,
    // 이 창은 우리가 직접 만든 audio.html만 불러오므로(외부 콘텐츠 없음) 신뢰할 수 있어
    // ipcRenderer를 직접 쓰도록 nodeIntegration을 허용한다.
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  audioWin.loadURL(`http://localhost:${port}/audio.html`);
  audioWin.on("closed", () => { audioWin = null; });
}

// 로비 화면(닉네임 입력 완료 시점)에서 보내는 신호를 받아 숨김 오디오 창에 재생을 지시한다.
ipcMain.on("start-music", () => {
  if (audioWin) audioWin.webContents.send("play-music");
});

// 설정 화면에서 바꾼 음악 볼륨/켜짐 여부를 숨김 오디오 창에 전달한다.
ipcMain.on("music-settings", (event, settings) => {
  if (audioWin) audioWin.webContents.send("music-settings", settings);
});

function createWindow(port, pos) {
  const win = new BrowserWindow({
    width: FIXED_WIDTH,
    height: FIXED_HEIGHT,
    x: pos ? pos.x : undefined,
    y: pos ? pos.y : undefined,
    // resizable:false로 두면 Windows에서 최대화 버튼/더블클릭 자체가 먹통이 되므로,
    // resizable은 true로 유지하고 대신 드래그로 인한 리사이즈 자체를 will-resize에서 미리 막는다.
    // (resize 이벤트에서 사후에 setSize로 되돌리면 깜빡이는 버그가 있어 will-resize로 교체)
    resizable: true,
    maximizable: true,
    autoHideMenuBar: true,
    // Windows는 네이티브 제목 표시줄 색을 직접 바꿀 수 없다. 네이티브 바를 숨기고
    // 최소화/최대화/닫기 버튼만 오버레이로 남긴 뒤, 그 자리는 페이지가 직접 그린다(.titlebar).
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      symbolColor: TITLEBAR_SYMBOL_COLOR,
      height: TITLEBAR_HEIGHT
    },
    webPreferences: {
      zoomFactor: 1,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.on("will-resize", (event) => {
    if (!win.isMaximized()) event.preventDefault();
  });

  // 브라우저 자체 확대/축소(핀치, Ctrl+휠, Ctrl+ +/-/0)를 완전히 차단한다.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.control) {
      const key = input.key.toLowerCase();
      if (["+", "-", "=", "0", "add", "subtract"].includes(key)) {
        event.preventDefault();
      }
      return;
    }
    // F5 새로고침 - 개발 중에만 (패키징된 빌드에서는 비활성화)
    if (!app.isPackaged && input.key === "F5" && input.type === "keyDown") {
      win.webContents.reload();
    }
  });

  win.loadURL(`http://localhost:${port}/index.html`);

  visibleWindowCount++;
  mainWindows.push(win);
  win.on("closed", () => {
    visibleWindowCount--;
    mainWindows.splice(mainWindows.indexOf(win), 1);
    if (visibleWindowCount === 0) {
      if (audioWin) audioWin.close();
      if (process.platform !== "darwin") app.quit();
    }
  });

  return win;
}

// npm run dev2 로 실행하면 창 두 개를 띄워 1대1 테스트를 바로 할 수 있다.
// 두 번째 창은 첫 번째 창 위치에서 살짝(오른쪽/아래로) 어긋나게 겹쳐서, 새로 뜬 창이 맨 위로 오게 한다.
const dualMode = process.argv.includes("--dual");
const CASCADE_OFFSET = 32;

if (gotLock) {
  // 웹사이트에서 bsbattle:// 링크로 다시 실행을 시도했을 때(이미 켜져 있는 경우) 여기로 들어온다.
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      const win = wins[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 개발 중 이전에 캐시된 구버전 파일이 남아있을 수 있으니 시작할 때 한 번 비운다.
    await session.defaultSession.clearCache();
    const port = await startServer();
    createAudioWindow(port);
    const win1 = createWindow(port);
    if (dualMode) {
      const b = win1.getBounds();
      createWindow(port, { x: b.x + CASCADE_OFFSET, y: b.y + CASCADE_OFFSET });
    }

    app.on("activate", () => {
      if (visibleWindowCount === 0) createWindow(port);
    });

    // 패키징된 빌드에서만 GitHub Releases를 확인해 새 버전이 있으면 자동으로 받아 다음 실행 시 적용한다.
    // 진행 상황을 화면에도 보여줘서, 조용히 실패했는지 실제로 진행 중인지 사용자가 알 수 있게 한다.
    if (app.isPackaged) {
      autoUpdater.on("update-available", (info) => {
        broadcastUpdateStatus({ type: "available", version: info.version });
      });
      autoUpdater.on("download-progress", (p) => {
        broadcastUpdateStatus({ type: "downloading", percent: Math.round(p.percent) });
      });
      autoUpdater.on("update-downloaded", (info) => {
        broadcastUpdateStatus({ type: "ready", version: info.version });
      });
      autoUpdater.on("error", (err) => {
        broadcastUpdateStatus({ type: "error", message: err && err.message });
      });

      autoUpdater.checkForUpdates().catch((err) => {
        console.error("업데이트 확인 실패:", err);
      });
    }
  });
}
