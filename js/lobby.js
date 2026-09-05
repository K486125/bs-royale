import { firebaseConfig } from "./firebase-config.js";
import { unitFrameClass, unitNumber } from "./unit-colors.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getDatabase, ref, set, update, push, onValue, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const AVATARS = [
  "Shelly_001_Icon.png",
  "Nita_002_Icon.png",
  "Colt_003_Icon.png",
  "Bull_004_Icon.png",
  "Jessie_005_Icon.png",
  "Brock_006_Icon.png"
];
const AVATAR_PATH = "BS_Plr_Icons/";
const DEFAULT_UNIT = "Shelly_001_Icon.png";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let myUid = null;
let myName = sessionStorage.getItem("bs_name") || "";
let myAvatar = sessionStorage.getItem("bs_avatar") || DEFAULT_UNIT;
sessionStorage.setItem("bs_avatar", myAvatar);

let joinedRoomId = null; // 내가 게스트로 참가 요청 보낸 방 (수락 대기중)
let roomsCache = {};
let redirected = false;
const declineCooldowns = new Set(); // 거절당한 방: 3초간 재요청 버튼 비활성화

// ---------- DOM ----------
const nameModal = document.getElementById("name-modal");
const nameInput = document.getElementById("name-input");
const nameConfirmBtn = document.getElementById("name-confirm-btn");
const myNameLabel = document.getElementById("my-name-label");
const myAvatarImg = document.getElementById("my-avatar-img");
const myAvatarFrame = document.getElementById("my-avatar-frame");
const createRoomBtn = document.getElementById("create-room-btn");
const toggleSidebarBtn = document.getElementById("toggle-sidebar-btn");
const sidebarPanel = document.querySelector(".panel");
const roomListEl = document.getElementById("room-list");
const toastEl = document.getElementById("toast");
const avatarModal = document.getElementById("avatar-modal");
const avatarPickerRow = document.getElementById("avatar-picker-row");
const setupAvatarImg = document.getElementById("setup-avatar-img");
const setupAvatarFrame = document.getElementById("setup-avatar-frame");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function avatarUrl(file) {
  return AVATAR_PATH + file;
}

function defaultUnits() {
  return [DEFAULT_UNIT, null, null];
}

function avatarCardMarkup(file) {
  return `
    <li class="bs-card">
      <div class="identity-portrait">
        <div class="identity-avatar ${unitFrameClass(file)}"><img src="${avatarUrl(file)}" alt=""></div>
      </div>
      <div class="card-label">${unitNumber(file)}</div>
      <div class="card-bar bar-select pick-avatar" data-file="${file}">선택</div>
    </li>
  `;
}

function renderAvatarGrid(rowEl, onPick) {
  rowEl.innerHTML = AVATARS.map(avatarCardMarkup).join("");
  rowEl.scrollLeft = 0; // 이전에 스크롤해둔 위치가 남아 001이 안 보이는 문제 방지
  rowEl.querySelectorAll(".pick-avatar").forEach((el) => {
    el.addEventListener("click", () => onPick(el.dataset.file));
  });
}

// 세로 마우스 휠로도 가로 스크롤이 되게 한다.
avatarPickerRow.addEventListener("wheel", (e) => {
  if (e.deltaY === 0) return;
  e.preventDefault();
  avatarPickerRow.scrollLeft += e.deltaY * 2.2;
}, { passive: false });

// 내 아바타를 바꾸고, 열려 있는 모든 프로필 미리보기(헤더 + 닉네임 설정창)에 반영한다.
function applyAvatarSelection(file) {
  myAvatar = file;
  sessionStorage.setItem("bs_avatar", myAvatar);
  const isGreen = unitFrameClass(myAvatar) === "frame-green";

  myAvatarImg.src = avatarUrl(myAvatar);
  myAvatarFrame.classList.toggle("frame-green", isGreen);

  setupAvatarImg.src = avatarUrl(myAvatar);
  setupAvatarFrame.classList.toggle("frame-green", isGreen);

  if (myUid) {
    update(ref(db, `presence/${myUid}`), { avatar: myAvatar });
  }
}

function openAvatarPicker() {
  renderAvatarGrid(avatarPickerRow, (file) => {
    applyAvatarSelection(file);
    avatarModal.classList.add("hidden");
  });
  avatarModal.classList.remove("hidden");
}

myAvatarFrame.addEventListener("click", openAvatarPicker);
setupAvatarFrame.addEventListener("click", openAvatarPicker);
// 카드 바깥(오버레이) 클릭 시 닫기
avatarModal.addEventListener("click", (e) => {
  if (e.target === avatarModal) {
    avatarModal.classList.add("hidden");
  }
});

toggleSidebarBtn.addEventListener("click", () => {
  sidebarPanel.classList.toggle("collapsed");
});

// ---------- 닉네임 & 프로필 설정 ----------
function initNickname() {
  myAvatarImg.src = avatarUrl(myAvatar);
  myAvatarFrame.classList.toggle("frame-green", unitFrameClass(myAvatar) === "frame-green");
  setupAvatarImg.src = avatarUrl(myAvatar);
  setupAvatarFrame.classList.toggle("frame-green", unitFrameClass(myAvatar) === "frame-green");

  if (myName) {
    nameModal.classList.add("hidden");
    myNameLabel.textContent = myName;
    startApp();
  } else {
    nameModal.classList.remove("hidden");
  }
}

nameConfirmBtn.addEventListener("click", () => {
  const v = nameInput.value.trim();
  if (!v) return;
  myName = v.slice(0, 12);
  sessionStorage.setItem("bs_name", myName);
  myNameLabel.textContent = myName;
  nameModal.classList.add("hidden");
  startApp();
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameConfirmBtn.click();
});

// ---------- 인증 & presence ----------
function startApp() {
  // 닉네임 입력을 마치고 로비에 도달하는 시점(재방문 시에도 동일 시점)에 배경음악을 시작한다.
  if (window.bsApi) window.bsApi.startMusic();

  setPersistence(auth, browserSessionPersistence)
    .then(() => signInAnonymously(auth))
    .catch((err) => {
      console.error(err);
      showToast("로그인 실패: " + err.message);
    });
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  myUid = user.uid;

  const presenceRef = ref(db, `presence/${myUid}`);
  set(presenceRef, {
    name: myName,
    avatar: myAvatar,
    connectedAt: serverTimestamp()
  });
  onDisconnect(presenceRef).remove();

  watchRooms();
});

// ---------- 방 목록 렌더링 ----------
function watchRooms() {
  onValue(ref(db, "rooms"), (snap) => {
    roomsCache = snap.val() || {};

    if (redirectIfAlreadyInRoom()) return;

    renderRoomList();
    updateCreateButton();
  });
}

// 이미 호스트/게스트로 속해 있는 방이 있으면 팀 화면으로 바로 이동시킨다.
function redirectIfAlreadyInRoom() {
  if (redirected) return true;
  const found = Object.entries(roomsCache).find(
    ([, room]) => room.hostUid === myUid || room.guestUid === myUid
  );
  if (found) {
    redirected = true;
    window.location.href = `room.html?room=${found[0]}`;
    return true;
  }
  return false;
}

function updateCreateButton() {
  if (joinedRoomId) {
    createRoomBtn.disabled = true;
    createRoomBtn.textContent = "참가 요청 중...";
  } else {
    createRoomBtn.disabled = false;
    createRoomBtn.textContent = "방 만들기";
  }
}

function renderRoomList() {
  roomListEl.innerHTML = "";
  // 방장이 접속을 끊은 방(앱을 강제 종료했거나 방치된 방)은 목록에서 감춘다.
  const ids = Object.keys(roomsCache).filter((id) => roomsCache[id].hostOnline !== false);

  if (ids.length === 0) {
    roomListEl.innerHTML = `<li class="empty">생성된 방이 없습니다. 방을 만들어보세요!</li>`;
    return;
  }

  ids.forEach((roomId) => {
    const room = roomsCache[roomId];
    const li = document.createElement("li");
    li.className = "room-card";

    const isFull = room.playerCount >= 2;

    let actionHtml;
    if (isFull) {
      actionHtml = `<button class="btn small" disabled>가득 참</button>`;
    } else if (joinedRoomId === roomId) {
      actionHtml = `<button class="btn small" disabled>요청됨</button>`;
    } else if (declineCooldowns.has(roomId)) {
      actionHtml = `<button class="btn small" disabled>거절됨 (재시도 대기)</button>`;
    } else if (joinedRoomId) {
      actionHtml = `<button class="btn small" disabled>다른 방 대기중</button>`;
    } else {
      actionHtml = `<button class="btn small invite-btn" data-room="${roomId}">초대</button>`;
    }

    li.innerHTML = `
      <div class="room-avatar-wrap">
        <img class="host-crown-small" src="BS_UI_ZIP/Host_Crown_Icon.png" alt="방장">
        <span class="avatar-frame ${unitFrameClass(room.hostAvatar || AVATARS[0])}"><img class="avatar" src="${avatarUrl(room.hostAvatar || AVATARS[0])}" alt=""></span>
      </div>
      <div class="room-info">
        <div class="room-host">${escapeHtml(room.hostName)}</div>
      </div>
      <div class="room-count">${room.playerCount}/2</div>
      ${actionHtml}
    `;
    roomListEl.appendChild(li);
  });

  roomListEl.querySelectorAll(".invite-btn").forEach((btn) => {
    btn.addEventListener("click", () => requestJoin(btn.dataset.room));
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

// ---------- 방 생성 ----------
createRoomBtn.addEventListener("click", async () => {
  if (createRoomBtn.disabled) return;
  createRoomBtn.disabled = true;
  createRoomBtn.textContent = "생성 중...";

  const roomRef = push(ref(db, "rooms"));
  await set(roomRef, {
    hostUid: myUid,
    hostName: myName,
    hostAvatar: myAvatar,
    hostUnits: defaultUnits(),
    hostReady: false,
    hostOnline: true,
    guestUid: null,
    guestName: null,
    guestAvatar: null,
    guestUnits: null,
    guestReady: false,
    playerCount: 1,
    status: "waiting",
    createdAt: serverTimestamp(),
    lastSeen: serverTimestamp()
  });

  window.location.href = `room.html?room=${roomRef.key}`;
});

// ---------- 참가 요청 보내기 (게스트) ----------
async function requestJoin(roomId) {
  if (joinedRoomId) return;
  joinedRoomId = roomId;
  renderRoomList();
  updateCreateButton();

  await set(ref(db, `rooms/${roomId}/requests/${myUid}`), {
    guestName: myName,
    guestAvatar: myAvatar,
    guestUnits: defaultUnits(),
    createdAt: serverTimestamp()
  });
  onDisconnect(ref(db, `rooms/${roomId}/requests/${myUid}`)).remove();

  watchJoinedRoom(roomId);
}

let navigatingToJoinedRoom = false;
// cancel()이 서버에 반영되기 전에 페이지를 이동하면 예약해둔 요청-정리(remove)가
// 그대로 발동할 수 있어, 취소가 끝난 뒤에만 이동한다.
async function goToJoinedRoom(roomId) {
  if (navigatingToJoinedRoom) return;
  navigatingToJoinedRoom = true;

  redirected = true;
  // 수락되면 요청 노드는 이미 지워지므로 이 예약은 무의미해지지만, 정리해두고 넘어간다.
  await onDisconnect(ref(db, `rooms/${roomId}/requests/${myUid}`)).cancel();
  window.location.href = `room.html?room=${roomId}`;
}

let joinedRoomUnsub = null;
function watchJoinedRoom(roomId) {
  const roomRef = ref(db, `rooms/${roomId}`);
  joinedRoomUnsub = onValue(roomRef, (snap) => {
    const room = snap.val();
    // 이동 중에는 상태 변화에 반응하지 않는다 (이동 직전에 취소해둔 처리를 되살리지 않기 위해)
    if (navigatingToJoinedRoom) return;

    if (!room) {
      showToast("호스트가 방을 나갔습니다.");
      resetJoinState();
      return;
    }
    if (room.guestUid === myUid) {
      goToJoinedRoom(roomId);
    } else if (!room.requests || !(myUid in room.requests)) {
      showToast("참가 요청이 거절되었거나 다른 플레이어가 참가했습니다.");
      resetJoinState();
      startDeclineCooldown(roomId);
    }
  });
}

function resetJoinState() {
  if (joinedRoomUnsub) {
    joinedRoomUnsub();
    joinedRoomUnsub = null;
  }
  joinedRoomId = null;
  renderRoomList();
  updateCreateButton();
}

function startDeclineCooldown(roomId) {
  declineCooldowns.add(roomId);
  renderRoomList();
  setTimeout(() => {
    declineCooldowns.delete(roomId);
    renderRoomList();
  }, 3000);
}

// 업데이트 다운로드/적용 상태를 사용자가 눈으로 확인할 수 있게 토스트로 보여준다.
// (확인 중/새 버전 없음/에러는 매번 조용히 넘어가고, 실제로 뭔가 받고 있거나 다 됐을 때만 알림)
if (window.bsApi && window.bsApi.onUpdateStatus) {
  let lastPercent = -1;
  window.bsApi.onUpdateStatus((status) => {
    if (status.type === "downloading") {
      if (status.percent === lastPercent) return;
      lastPercent = status.percent;
      showToast(`새 버전 다운로드 중... ${status.percent}%`);
    } else if (status.type === "ready") {
      showToast(`새 버전(v${status.version}) 준비 완료! 앱을 재시작하면 적용됩니다.`);
    }
  });
}

initNickname();
