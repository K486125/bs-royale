import { firebaseConfig } from "./firebase-config.js";
import { unitFrameClass } from "./unit-colors.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getDatabase, ref, update, onValue, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const AVATAR_PATH = "BS_Plr_Icons/";
const ROWS = 7;
const COLS = 7;
const BOUNDARY_ROW = 3; // 세로 7칸 중 가운데 한 줄 = 배치 불가 경계선
const PLACING_MS = 60000;
const LOADING_MIN_MS = 1400; // 로딩 화면 최소 노출 시간 (버벅거림 방지용 체감 대기)

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const params = new URLSearchParams(location.search);
const roomId = params.get("room");

let myUid = null;
let isHost = false;
let leaving = false;
let currentDisconnectRef = null;
let currentRoom = null;
let mapBuilt = false;

let myUnits = [null, null, null];
let selectedSlot = null;
let myDone = false;
let doneRequested = false;
const loadingStartedAt = Date.now();

let timerInterval = null;
let countdownInterval = null;

const loadingOverlay = document.getElementById("loading-overlay");
const battleMain = document.getElementById("battle-main");
const sidebarEl = document.getElementById("unit-sidebar");
const mapEl = document.getElementById("battle-map");
const timerEl = document.getElementById("placement-timer");
const countdownOverlay = document.getElementById("countdown-overlay");
const countdownNumberEl = document.getElementById("countdown-number");
const toastEl = document.getElementById("toast");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove("show"), 2000);
}

function backToLobby(message) {
  if (message) showToast(message);
  if (currentDisconnectRef) {
    onDisconnect(currentDisconnectRef).cancel();
    currentDisconnectRef = null;
  }
  setTimeout(() => { window.location.href = "index.html"; }, message ? 1200 : 0);
}

if (!roomId) {
  backToLobby();
} else {
  setPersistence(auth, browserSessionPersistence)
    .then(() => signInAnonymously(auth))
    .catch((err) => {
      console.error(err);
      showToast("로그인 실패: " + err.message);
    });
}

onAuthStateChanged(auth, (user) => {
  if (!user || !roomId) return;
  myUid = user.uid;
  watchRoom();
});

function watchRoom() {
  const roomRef = ref(db, `rooms/${roomId}`);

  onValue(roomRef, (snap) => {
    const room = snap.val();
    if (leaving) return;

    if (!room) {
      backToLobby("상대방이 방을 나갔습니다. 로비로 돌아갑니다.");
      return;
    }

    const hostMatch = room.hostUid === myUid;
    const guestMatch = room.guestUid === myUid;
    if (!hostMatch && !guestMatch) {
      backToLobby();
      return;
    }
    isHost = hostMatch;

    if (!room.battle) {
      // 배치 단계가 아직 시작 안 된 상태로 이 화면에 온 비정상 케이스 -> 대기실로.
      backToLobby();
      return;
    }

    currentRoom = room;

    if (!mapBuilt) {
      buildMap();
      mapBuilt = true;
    }

    updateDisconnectHandling(room);
    renderBattle(room);

    if (isHost) maybeAdvancePhase(room);
  });

  window.addEventListener("beforeunload", () => {
    if (currentDisconnectRef) onDisconnect(currentDisconnectRef).cancel();
  });
}

function battleField() {
  return isHost ? "hostPlacements" : "guestPlacements";
}
function doneField() {
  return isHost ? "hostDone" : "guestDone";
}
function myAreaRows() {
  return isHost ? [4, 5, 6] : [0, 1, 2];
}
function isMyAreaRow(r) {
  return isHost ? r > BOUNDARY_ROW : r < BOUNDARY_ROW;
}

// ---------- 맵 생성 ----------
function buildMap() {
  mapEl.innerHTML = "";
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = r;
      tile.dataset.col = c;

      if (r === BOUNDARY_ROW) {
        tile.classList.add("boundary");
      } else {
        tile.classList.add(isMyAreaRow(r) ? "mine-area" : "enemy-area");
      }

      // 게스트는 자신의 영역이 항상 화면 아래쪽에 오도록 세로로만 뒤집어서 배치한다 (좌우는 그대로).
      const displayRow = isHost ? r : (ROWS - 1 - r);
      tile.style.gridRowStart = displayRow + 1;
      tile.style.gridColumnStart = c + 1;

      mapEl.appendChild(tile);
    }
  }
  mapEl.addEventListener("click", onTileClick);
  mapEl.addEventListener("contextmenu", onTileRightClick);
}

function placedSlotSet(placements) {
  const set = new Set();
  Object.values(placements).forEach((p) => { if (p) set.add(p.slot); });
  return set;
}

// ---------- 사이드바 (내 유닛 3개) ----------
function renderSidebar(myPlacements) {
  const placed = placedSlotSet(myPlacements);
  sidebarEl.innerHTML = "";

  for (let i = 0; i < 3; i++) {
    const file = myUnits[i];
    if (!file) continue; // 선택 안 한 슬롯은 배치 대상이 아님

    const isPlaced = placed.has(i);
    const card = document.createElement("div");
    card.className = "unit-slot-card"
      + (isPlaced ? " placed" : "")
      + (selectedSlot === i ? " selected" : "");
    card.innerHTML = `
      <div class="portrait-frame ${unitFrameClass(file)}">
        <img class="card-portrait" src="${AVATAR_PATH}${file}" alt="">
      </div>
    `;

    if (!isPlaced && !myDone) {
      card.addEventListener("click", () => {
        selectedSlot = (selectedSlot === i) ? null : i;
        renderSidebar(myPlacements);
      });
    }
    sidebarEl.appendChild(card);
  }
}

// ---------- 맵 타일 렌더링 ----------
function renderMapTiles(myPlacements, oppPlacements) {
  mapEl.querySelectorAll(".tile").forEach((tile) => {
    const key = `${tile.dataset.row}_${tile.dataset.col}`;
    const placement = myPlacements[key] || oppPlacements[key];

    tile.classList.toggle("occupied", !!placement);
    tile.innerHTML = placement
      ? `<div class="tile-unit-frame ${unitFrameClass(placement.file)}"><img src="${AVATAR_PATH}${placement.file}" alt=""></div>`
      : "";
  });
}

function onTileClick(e) {
  const tile = e.target.closest(".tile");
  if (!tile || myDone || selectedSlot === null) return;

  const r = Number(tile.dataset.row);
  const c = Number(tile.dataset.col);
  if (r === BOUNDARY_ROW || !isMyAreaRow(r)) return;

  const key = `${r}_${c}`;
  const myPlacements = (currentRoom.battle && currentRoom.battle[battleField()]) || {};
  if (myPlacements[key]) return; // 이미 배치된 타일

  const file = myUnits[selectedSlot];
  if (!file) return;

  const slot = selectedSlot;
  selectedSlot = null;
  update(ref(db, `rooms/${roomId}/battle/${battleField()}`), { [key]: { slot, file } });
}

function onTileRightClick(e) {
  e.preventDefault();
  if (myDone) return;

  const tile = e.target.closest(".tile");
  if (!tile) return;

  const key = `${tile.dataset.row}_${tile.dataset.col}`;
  const myPlacements = (currentRoom.battle && currentRoom.battle[battleField()]) || {};
  if (!myPlacements[key]) return;

  update(ref(db, `rooms/${roomId}/battle/${battleField()}`), { [key]: null });
}

// ---------- 배치 타이머 ----------
function renderTimer(battle) {
  clearInterval(timerInterval);

  if (battle.phase !== "placing" || !battle.placingStartedAt) {
    timerEl.classList.add("hidden");
    return;
  }
  timerEl.classList.remove("hidden");

  const tick = () => {
    const remain = Math.max(0, PLACING_MS - (Date.now() - battle.placingStartedAt));
    const sec = Math.ceil(remain / 1000);

    timerEl.textContent = myDone
      ? "배치 완료! 상대 대기 중..."
      : `배치 시간: 0:${String(sec).padStart(2, "0")}`;

    if (remain <= 0 && !myDone) {
      clearInterval(timerInterval);
      finalizePlacement();
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

// 시간 안에 다 못 배치한 슬롯을 내 영역의 빈 타일에 무작위로 채운다.
async function finalizePlacement() {
  if (myDone || doneRequested) return;

  const battle = currentRoom.battle || {};
  const myPlacements = battle[battleField()] || {};
  const placed = placedSlotSet(myPlacements);
  const remainingSlots = [0, 1, 2].filter((i) => myUnits[i] && !placed.has(i));

  if (remainingSlots.length > 0) {
    const occupiedKeys = new Set(Object.keys(myPlacements));
    const emptyTiles = [];
    myAreaRows().forEach((r) => {
      for (let c = 0; c < COLS; c++) {
        const key = `${r}_${c}`;
        if (!occupiedKeys.has(key)) emptyTiles.push(key);
      }
    });
    shuffle(emptyTiles);

    const updates = {};
    remainingSlots.forEach((slot, idx) => {
      const key = emptyTiles[idx];
      if (key) updates[key] = { slot, file: myUnits[slot] };
    });
    if (Object.keys(updates).length > 0) {
      await update(ref(db, `rooms/${roomId}/battle/${battleField()}`), updates);
    }
  }

  await markDone();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function markDone() {
  doneRequested = true;
  await update(ref(db, `rooms/${roomId}/battle`), { [doneField()]: true });
}

function maybeAutoComplete(myPlacements) {
  if (myDone || doneRequested) return;
  const placed = placedSlotSet(myPlacements);
  const requiredSlots = [0, 1, 2].filter((i) => myUnits[i]);
  const allPlaced = requiredSlots.length > 0 && requiredSlots.every((i) => placed.has(i));
  if (allPlaced) markDone();
}

// ---------- 카운트다운 (3,2,1,0에서 멈춤 - 이후 게임 로직은 아직 없음) ----------
function renderCountdown(battle) {
  clearInterval(countdownInterval);

  if (battle.phase !== "countdown" || !battle.countdownStartedAt) {
    countdownOverlay.classList.add("hidden");
    return;
  }
  countdownOverlay.classList.remove("hidden");

  const tick = () => {
    const remain = Math.max(0, 3000 - (Date.now() - battle.countdownStartedAt));
    const n = Math.ceil(remain / 1000);
    countdownNumberEl.textContent = String(n);
    if (remain <= 0) clearInterval(countdownInterval);
  };
  tick();
  countdownInterval = setInterval(tick, 100);
}

// ---------- 로딩 -> 배치 화면 전환 (최소 노출 시간 보장) ----------
function renderPhaseVisibility(battle) {
  if (battle.phase === "loading") {
    loadingOverlay.classList.remove("hidden");
    battleMain.classList.add("hidden");
    return;
  }

  const elapsed = Date.now() - loadingStartedAt;
  if (elapsed < LOADING_MIN_MS) {
    setTimeout(() => renderPhaseVisibility(currentRoom.battle), LOADING_MIN_MS - elapsed);
    return;
  }
  loadingOverlay.classList.add("hidden");
  battleMain.classList.remove("hidden");
}

// 호스트가 대표로 단계를 진행시킨다 (로딩 -> 배치, 둘 다 배치 완료 -> 카운트다운).
async function maybeAdvancePhase(room) {
  const battle = room.battle;
  if (!battle) return;

  if (battle.phase === "loading") {
    const elapsed = Date.now() - (battle.createdAt || Date.now());
    if (elapsed >= LOADING_MIN_MS) {
      await update(ref(db, `rooms/${roomId}/battle`), {
        phase: "placing",
        placingStartedAt: serverTimestamp()
      });
    }
  } else if (battle.phase === "placing" && battle.hostDone && battle.guestDone && !battle.countdownStartedAt) {
    await update(ref(db, `rooms/${roomId}/battle`), {
      phase: "countdown",
      countdownStartedAt: serverTimestamp()
    });
  }
}

function renderBattle(room) {
  const battle = room.battle;
  myUnits = (isHost ? room.hostUnits : room.guestUnits) || [null, null, null];
  myDone = !!(isHost ? battle.hostDone : battle.guestDone);

  renderPhaseVisibility(battle);

  const myPlacements = battle[battleField()] || {};
  const oppPlacements = battle[isHost ? "guestPlacements" : "hostPlacements"] || {};

  renderSidebar(myPlacements);
  renderMapTiles(myPlacements, oppPlacements);
  renderTimer(battle);
  renderCountdown(battle);
  maybeAutoComplete(myPlacements);
}

// ---------- 연결 끊김 처리 (대기실과 동일한 규칙: 호스트 나가면 게스트가 승계, 아니면 대기 상태로 리셋) ----------
function updateDisconnectHandling(room) {
  const roomRef = ref(db, `rooms/${roomId}`);

  if (currentDisconnectRef) {
    onDisconnect(currentDisconnectRef).cancel();
    currentDisconnectRef = null;
  }

  if (isHost) {
    if (room.guestUid) {
      onDisconnect(roomRef).update({
        hostUid: room.guestUid,
        hostName: room.guestName,
        hostAvatar: room.guestAvatar,
        hostUnits: room.guestUnits,
        hostReady: false,
        guestUid: null,
        guestName: null,
        guestAvatar: null,
        guestUnits: null,
        guestReady: false,
        playerCount: 1,
        status: "waiting",
        battle: null
      });
    } else {
      onDisconnect(roomRef).remove();
    }
  } else {
    onDisconnect(roomRef).update({
      guestUid: null,
      guestName: null,
      guestAvatar: null,
      guestUnits: null,
      guestReady: false,
      playerCount: 1,
      status: "waiting",
      battle: null
    });
  }
  currentDisconnectRef = roomRef;
}
