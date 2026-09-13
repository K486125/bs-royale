// 업데이트 화면. 로비·대기실·전투 어느 페이지에서든 불러오기만 하면 된다.
//
// 새 버전을 받는 동안에는 화면 전체를 덮어 게임을 못 하게 하고,
// 다 받아지면 "앱 재실행" 버튼을 보여준다. 누르면 앱이 닫혔다가 새 버전으로 다시 켜진다.
// 업데이트가 실패하면 덮개를 걷고 원래대로 게임을 할 수 있게 한다.
import { pushNotice } from "./notice.js";

const api = window.bsApi;
let overlay = null;
let titleEl, textEl, barEl, fillEl, percentEl, restartBtn;
let shown = false;

function build() {
  overlay = document.createElement("div");
  overlay.className = "update-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="update-card">
      <div class="update-spinner" aria-hidden="true"></div>
      <div class="update-title"></div>
      <div class="update-text"></div>
      <div class="update-bar"><i class="update-fill"></i></div>
      <div class="update-percent"></div>
      <button type="button" class="update-restart hidden">앱 재실행</button>
    </div>
  `;
  document.body.appendChild(overlay);

  titleEl = overlay.querySelector(".update-title");
  textEl = overlay.querySelector(".update-text");
  barEl = overlay.querySelector(".update-bar");
  fillEl = overlay.querySelector(".update-fill");
  percentEl = overlay.querySelector(".update-percent");
  restartBtn = overlay.querySelector(".update-restart");

  restartBtn.addEventListener("click", () => {
    if (restartBtn.disabled) return;
    restartBtn.disabled = true;
    restartBtn.textContent = "재실행 중...";
    api.restartToUpdate();
  });
}

function show() {
  if (!overlay) build();
  overlay.classList.remove("hidden");
  shown = true;
  // 덮개 뒤에 있던 입력칸이 계속 글자를 받지 않게 한다.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function hide() {
  if (overlay) overlay.classList.add("hidden");
  shown = false;
}

// 받는 중인데 한동안 아무 소식이 없으면(오류도 없이 멈춤) 덮개를 걷어 게임을 계속하게 한다.
// 나중에 다 받아지면 그때 다시 재실행 화면이 뜬다.
const STALL_MS = 90000;
let stallTimer = null;
function watchStall() {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (!shown || (overlay && overlay.classList.contains("ready"))) return;
    hide();
    pushNotice("업데이트가 멈춰 있어 게임을 계속합니다.\n다음에 앱을 켤 때 다시 시도합니다.", { duration: 3600 });
  }, STALL_MS);
}

function render(status) {
  if (!status) return;
  const version = status.version ? `새 버전(v${status.version})` : "새 버전";
  if (status.type !== "available" && status.type !== "downloading") clearTimeout(stallTimer);

  if (status.type === "available" || status.type === "downloading") {
    show();
    watchStall();
    const percent = status.type === "downloading" ? Math.max(0, Math.min(100, status.percent || 0)) : 0;
    overlay.classList.remove("ready");
    titleEl.textContent = "업데이트 중";
    textEl.textContent = `${version}을 받고 있습니다. 잠시만 기다려 주세요.`;
    barEl.classList.remove("hidden");
    fillEl.style.width = `${percent}%`;
    percentEl.textContent = status.type === "downloading" ? `${percent}%` : "준비 중...";
    restartBtn.classList.add("hidden");
    return;
  }

  if (status.type === "ready") {
    show();
    overlay.classList.add("ready");
    titleEl.textContent = "업데이트 준비 완료";
    textEl.textContent = `앱을 재실행하면 ${version}이 적용됩니다.`;
    barEl.classList.remove("hidden");
    fillEl.style.width = "100%";
    percentEl.textContent = "";
    restartBtn.classList.remove("hidden");
    restartBtn.disabled = false;
    restartBtn.textContent = "앱 재실행";
    restartBtn.focus();
    return;
  }

  if (status.type === "error") {
    // 받는 도중 실패했으면 가두지 않는다. 다음에 앱을 켤 때 다시 시도한다.
    if (shown) {
      hide();
      pushNotice("업데이트를 받지 못했습니다.\n다음에 앱을 켤 때 다시 시도합니다.", { duration: 3200 });
    }
  }
}

// 덮개가 떠 있는 동안에는 게임 단축키(W, A, 1~3, 방향키, 엔터 등)가 뒤로 새지 않게 막는다.
// 재실행 버튼만은 엔터/스페이스로 누를 수 있게 둔다.
window.addEventListener("keydown", (e) => {
  if (!shown) return;
  if (e.target === restartBtn && (e.key === "Enter" || e.key === " ")) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

if (api && api.onUpdateStatus) {
  api.onUpdateStatus(render);
  // 페이지를 옮겨 온 경우 이미 진행 중인 업데이트를 이어서 보여준다.
  if (api.getUpdateStatus) api.getUpdateStatus().then(render).catch(() => {});
}
