import { firebaseConfig } from "./firebase-config.js";
import { unitFrameClass } from "./unit-colors.js";
import { playSelect } from "./sfx.js";
import {
  newChatKey, watchChatData, isLastLeaveNotice, noticeEntry, trimRootUpdates
} from "./chat.js";
import { initServerTime, serverNow, serverTimeReady, whenServerTime } from "./server-time.js";
import { pushNotice } from "./notice.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getDatabase, ref, set, update, onValue, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const AVATAR_PATH = "BS_Plr_Icons/";
const ROWS = 7;
const COLS = 7;
const BOUNDARY_ROW = 3; // 세로 7칸 중 가운데 한 줄 = 배치 불가 경계선
const PLACING_MS = 60000;
const LOADING_MIN_MS = 1400; // 로딩 화면 최소 노출 시간 (버벅거림 방지용 체감 대기)
const MATCH_END_MS = 1800; // "매치 종료" 문구를 보여주는 시간
const LEAVE_NOTICE_MS = 1100; // 상대 퇴장 알림을 보여주는 시간 (이후 로딩 화면)

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// 배치 시간/카운트다운은 모두 서버 타임스탬프 기준이므로 서버 시각으로 계산한다.
initServerTime(db);

const params = new URLSearchParams(location.search);
const roomId = params.get("room");

let myUid = null;
let isHost = false;
let leaving = false;
let currentRoom = null;
let mapBuilt = false;

let myUnits = [null, null, null];
let selectedSlot = null;
let myDone = false;
let doneRequested = false;
const loadingStartedAt = Date.now();

let timerInterval = null;
let countdownInterval = null;
let matchFinished = false; // 정상 종료로 대기실에 돌아가는 중인지 (상대 이탈과 구분)

const loadingOverlay = document.getElementById("loading-overlay");
const battleMain = document.getElementById("battle-main");
const sidebarEl = document.getElementById("unit-sidebar");
const mapEl = document.getElementById("battle-map");
const timerEl = document.getElementById("placement-timer");
const matchEndOverlay = document.getElementById("match-end-overlay");
const toastEl = document.getElementById("toast");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove("show"), 2000);
}

function backToLobby(message) {
  if (message) showToast(message);
  setTimeout(() => { window.location.href = "index.html"; }, message ? 1200 : 0);
}

function showBattleLoading(text) {
  loadingOverlay.querySelector(".loading-text").textContent = text;
  loadingOverlay.classList.remove("hidden");
  battleMain.classList.add("hidden");
}

let leavingBattle = false;
// 전투가 사라졌을 뿐 방에는 그대로 속해 있는 상태 -> 로비가 아니라 대기실로 돌아간다.
// (상대가 나가면 남은 쪽이 battle을 지우므로 이 경로로 들어온다)
async function backToRoom(message) {
  if (leavingBattle) return;
  leavingBattle = true;

  if (message) {
    // 알림이 완전히 사라진 뒤에 로딩 화면을 띄운다.
    await pushNotice(message, { duration: LEAVE_NOTICE_MS });
    showBattleLoading("대기실로 돌아가는 중...");
    goRoom();
    return;
  }
  goRoom();
}

async function goRoom() {
  // 내가 스스로 넘어가는 것임을 남겨야, 이 순간 잠깐 끊기는 것을 상대가 "나갔다"고 보지 않는다.
  // 다만 이 기록이 늦어진다고 화면 이동이 막히면 안 되므로 오래 기다리지 않는다.
  await Promise.race([setNavigating(true), wait(1500)]);
  window.location.href = `room.html?room=${roomId}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 화면 이동으로 인한 접속 끊김과 창을 꺼버린 것을 구분하기 위한 표시.
async function setNavigating(on) {
  if (!presenceRole) return;
  try {
    await update(ref(db, `rooms/${roomId}`), { [`${presenceRole}Navigating`]: on });
  } catch (err) {
    // 실패하면 상대는 기존처럼 넉넉한 대기시간을 쓰게 되므로 그대로 진행한다.
    console.error("이동 표시 실패:", err);
  }
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
  // 전투 화면에는 채팅 UI가 없지만, 퇴장 알림이 이미 남았는지 확인해야 해서
  // 대화 내용은 계속 지켜본다.
  watchChatData(db, roomId);
  watchRoom();
});

function watchRoom() {
  const roomRef = ref(db, `rooms/${roomId}`);

  onValue(roomRef, (snap) => {
    const room = snap.val();
    if (leaving || leavingBattle) return;

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

    currentRoom = room;
    updatePresence(isHost);
    watchOpponentPresence(room, isHost);

    if (!room.battle) {
      // 정상적으로 매치가 끝나서 지워진 경우와, 상대가 나가서 지워진 경우를 구분한다.
      const opponentGone = isHost ? !room.guestUid : !room.hostUid;
      const leftMessage = (!matchFinished && !leaveAnnounced && mapBuilt && opponentGone)
        ? "상대방이 나갔습니다. 대기실로 돌아갑니다."
        : "";
      backToRoom(leftMessage);
      return;
    }

    if (!mapBuilt) {
      buildMap();
      mapBuilt = true;
    }

    renderBattle(room);

    if (isHost) maybeAdvancePhase(room);
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
      <div class="unit-tile ${unitFrameClass(file)}">
        <img src="${AVATAR_PATH}${file}" alt="">
      </div>
    `;

    // 사이드바에서 유닛을 고르는 것만으로는 소리를 내지 않는다.
    // 효과음은 실제로 타일에 배치했을 때만 난다 (onTileClick 참고).
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

  playSelect();
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

  // 서버 시각을 아직 모르면 남은 시간을 계산할 수 없다. 보정 전에 계산하면 PC 시계 오차만큼
  // 엉뚱한 값이 나오므로(시계가 빠른 PC에서는 즉시 0), 알게 될 때까지 전체 시간을 보여준다.
  if (!serverTimeReady()) {
    timerEl.textContent = `배치 시간: 0:${String(PLACING_MS / 1000).padStart(2, "0")}`;
    whenServerTime(() => {
      if (currentRoom && currentRoom.battle) renderTimer(currentRoom.battle);
    });
    return;
  }

  const tick = () => {
    const remain = Math.max(0, PLACING_MS - (serverNow() - battle.placingStartedAt));
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

// ---------- 카운트다운 (3,2,1 - 화면 한가운데 알림으로 표시) ----------
// 어느 카운트다운의 몇 초를 이미 보여줬는지 기억해둔다.
// 방 데이터가 도착할 때마다 이 함수가 다시 불리기 때문에, 이게 없으면
// 같은 숫자의 애니메이션이 계속 다시 재생되어 덜덜 떨리는 것처럼 보인다.
let countdownShownAt = null;
let countdownShownNumber = 0;

function renderCountdown(battle) {
  clearInterval(countdownInterval);

  if (battle.phase !== "countdown" || !battle.countdownStartedAt) {
    countdownShownAt = null;
    countdownShownNumber = 0;
    return;
  }

  // 서버 시각을 알아야 남은 시간을 계산할 수 있다 (PC 시계가 어긋나 있어도 정확하도록).
  if (!serverTimeReady()) {
    whenServerTime(() => {
      if (currentRoom && currentRoom.battle) renderCountdown(currentRoom.battle);
    });
    return;
  }

  const tick = () => {
    const remain = Math.max(0, 3000 - (serverNow() - battle.countdownStartedAt));
    const n = Math.ceil(remain / 1000);

    // 초가 바뀔 때마다 같은 자리에서 문구만 갈아끼우고 등장 애니메이션을 다시 재생한다.
    if (n > 0 && (countdownShownAt !== battle.countdownStartedAt || countdownShownNumber !== n)) {
      countdownShownAt = battle.countdownStartedAt;
      countdownShownNumber = n;
      pushNotice(`잠시 후 매치가 시작됩니다. ${n}s`, { group: "countdown", duration: 1000 });
    }

    if (remain <= 0) {
      clearInterval(countdownInterval);
      // 아직 실제 전투 로직이 없으므로 카운트다운이 끝나면 바로 매치 종료로 넘어간다.
      // 방장이 대표로 기록하되, 어떤 이유로 기록되지 않으면 상대도 카운트다운 0에서 멈추므로
      // 몇 초 뒤에는 남은 쪽이 대신 기록한다.
      if (isHost) {
        finishMatch();
      } else {
        setTimeout(() => {
          const b = currentRoom && currentRoom.battle;
          if (b && b.phase === "countdown") finishMatch();
        }, 4000);
      }
    }
  };
  tick();
  countdownInterval = setInterval(tick, 100);
}

// ---------- 매치 종료 -> 대기실 복귀 ----------
let finishRequested = false;
async function finishMatch() {
  if (finishRequested) return;
  finishRequested = true;

  for (let i = 0; i < 3; i++) {
    try {
      await update(ref(db, `rooms/${roomId}/battle`), {
        phase: "finished",
        finishedAt: serverTimestamp()
      });
      return;
    } catch (err) {
      console.error(`매치 종료 기록 ${i + 1}번째 실패:`, err);
      await wait(1000);
    }
  }
  // 기록이 안 되면 상대 화면은 카운트다운 0에서 멈춘다. 최소한 이 사람은 내보낸다.
  // (그 사이 상대가 기록해서 이미 종료 절차가 시작됐다면 그대로 둔다)
  if (!finishSequenceStarted) handleFinish({ phase: "finished" });
}

let finishSequenceStarted = false;
function handleFinish(battle) {
  if (battle.phase !== "finished" || finishSequenceStarted) return;
  finishSequenceStarted = true;
  matchFinished = true;

  clearInterval(timerInterval);
  clearInterval(countdownInterval);
  matchEndOverlay.classList.remove("hidden");

  setTimeout(() => {
    matchEndOverlay.classList.add("hidden");
    loadingOverlay.querySelector(".loading-text").textContent = "대기실로 돌아가는 중...";
    loadingOverlay.classList.remove("hidden");
    battleMain.classList.add("hidden");
    // 호스트가 대표로 전투 데이터를 지운다. 준비 상태도 풀어야 대기실에서
    // 곧바로 다음 전투가 시작되지 않는다. 양쪽 모두 battle이 사라지면 대기실로 돌아간다.
    if (isHost) clearFinishedBattle();
    // 방장 쪽 쓰기가 실패하면 둘 다 로딩 화면에 갇히므로, 남은 쪽도 잠시 뒤 대신 지운다.
    else setTimeout(() => {
      if (currentRoom && currentRoom.battle) clearFinishedBattle();
    }, 2500);
  }, MATCH_END_MS);
}

async function clearFinishedBattle() {
  for (let i = 0; i < 3; i++) {
    try {
      await update(ref(db, `rooms/${roomId}`), {
        battle: null,
        hostReady: false,
        guestReady: false,
        // 채팅의 매치 종료 알림은 둘 다 대기실에 도착한 뒤에 남긴다 (room.js 참고).
        matchEndPending: true
      });
      return;
    } catch (err) {
      console.error(`전투 정리 ${i + 1}번째 실패:`, err);
      await wait(1200);
    }
  }
  pushNotice("방을 정리하지 못했습니다. 대기실로 돌아갑니다.");
  goRoom();
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
    setTimeout(() => {
      if (currentRoom && currentRoom.battle) renderPhaseVisibility(currentRoom.battle);
    }, LOADING_MIN_MS - elapsed);
    return;
  }
  loadingOverlay.classList.add("hidden");
  battleMain.classList.remove("hidden");
}

// 호스트가 대표로 단계를 진행시킨다 (로딩 -> 배치, 둘 다 배치 완료 -> 카운트다운).
let loadingAdvanceTimer = null;
async function maybeAdvancePhase(room) {
  const battle = room.battle;
  if (!battle) return;

  // 서버 시각을 모르는 동안에는 판단을 미룬다 (시계가 어긋난 PC에서 단계가 건너뛰지 않도록).
  if (!serverTimeReady()) {
    whenServerTime(() => {
      if (currentRoom) maybeAdvancePhase(currentRoom);
    });
    return;
  }

  if (battle.phase === "loading") {
    const elapsed = serverNow() - (battle.createdAt || serverNow());
    if (elapsed >= LOADING_MIN_MS) {
      await update(ref(db, `rooms/${roomId}/battle`), {
        phase: "placing",
        placingStartedAt: serverTimestamp()
      });
    } else if (!loadingAdvanceTimer) {
      // 이 확인은 방 데이터가 바뀔 때(onValue)만 실행되는데, 로딩이 끝나기를 기다리는 동안에는
      // 아무 변화도 없어서 영영 다시 확인되지 않는다. 시간이 되면 스스로 다시 확인한다.
      loadingAdvanceTimer = setTimeout(() => {
        loadingAdvanceTimer = null;
        if (currentRoom) maybeAdvancePhase(currentRoom);
      }, LOADING_MIN_MS - elapsed);
    }
  } else if (battle.phase === "placing" && battle.hostDone && battle.guestDone && !battle.countdownStartedAt) {
    await update(ref(db, `rooms/${roomId}/battle`), {
      phase: "countdown",
      countdownStartedAt: serverTimestamp()
    });
  }
}

// 상대가 유닛을 놓는 순간에도 같은 효과음이 들리도록, 새로 생긴 상대 배치를 감지한다.
// (처음 화면에 들어왔을 때 이미 놓여 있던 것들은 소리내지 않는다)
let knownOppKeys = null;
function playOpponentPlacementSfx(oppPlacements) {
  const keys = Object.keys(oppPlacements);
  if (knownOppKeys === null) {
    knownOppKeys = new Set(keys);
    return;
  }
  const added = keys.some((k) => !knownOppKeys.has(k));
  knownOppKeys = new Set(keys);
  if (added) playSelect();
}

function renderBattle(room) {
  const battle = room.battle;
  myUnits = (isHost ? room.hostUnits : room.guestUnits) || [null, null, null];
  myDone = !!(isHost ? battle.hostDone : battle.guestDone);

  if (battle.phase === "finished") {
    handleFinish(battle);
    return;
  }

  renderPhaseVisibility(battle);

  const myPlacements = battle[battleField()] || {};
  const oppPlacements = battle[isHost ? "guestPlacements" : "hostPlacements"] || {};

  playOpponentPlacementSfx(oppPlacements);
  renderSidebar(myPlacements);
  renderMapTiles(myPlacements, oppPlacements);
  renderTimer(battle);
  renderCountdown(battle);
  maybeAutoComplete(myPlacements);
}

// ---------- 접속 상태 (대기실과 동일한 규칙) ----------
// 끊길 때는 "나 접속 중" 표시만 끈다. 페이지 이동으로 잠깐 끊기는 것과 진짜 나간 것을
// 구분하기 위해, 상대가 나갔는지는 남아있는 쪽이 몇 초 지켜본 뒤 판단한다.
let presenceRole = null;
function updatePresence(isHost) {
  const role = isHost ? "host" : "guest";
  if (presenceRole === role) return;
  presenceRole = role;

  const onlineRef = ref(db, `rooms/${roomId}/${role}Online`);
  set(onlineRef, true);
  onDisconnect(onlineRef).set(false);

  const seenRef = ref(db, `rooms/${roomId}/lastSeen`);
  set(seenRef, serverTimestamp());
  onDisconnect(seenRef).set(serverTimestamp());

  // 도착했으므로 이동 중 표시를 끈다.
  update(ref(db, `rooms/${roomId}`), { [`${role}Navigating`]: false }).catch(() => {});
}

// 상대가 화면을 이동하는 중이라고 표시해 뒀다면 넉넉히 기다리고,
// 그런 표시 없이 끊겼다면(=창을 꺼버린 경우) 바로 판단한다.
const OPPONENT_GRACE_MS = 6000;
const OPPONENT_QUICK_MS = 400;
let opponentGoneTimer = null;
let leaveAnnounced = false;

function watchOpponentPresence(room, isHost) {
  const oppUid = isHost ? room.guestUid : room.hostUid;
  const oppOnline = isHost ? room.guestOnline : room.hostOnline;
  const oppNavigating = isHost ? room.guestNavigating : room.hostNavigating;

  if (!oppUid || oppOnline !== false) {
    clearTimeout(opponentGoneTimer);
    opponentGoneTimer = null;
    return;
  }
  if (opponentGoneTimer) return;

  const oppName = (isHost ? room.guestName : room.hostName) || "상대방";
  opponentGoneTimer = setTimeout(() => {
    opponentGoneTimer = null;
    // 먼저 알리고, 1초 뒤에 정리하면서 대기실로 넘어간다.
    leaveAnnounced = true;
    // 알림이 떠올랐다 사라지는 것까지 보여준 다음 로딩 화면으로 넘어간다.
    pushNotice(`${oppName}님이 나갔습니다.`, { duration: LEAVE_NOTICE_MS }).then(() => {
      showBattleLoading("대기실로 돌아가는 중...");
      handleOpponentLeft();
    });
    // 이동 표시가 명시적으로 false일 때만 "창을 껐다"고 단정한다.
    // 표시가 아예 없는 경우(예전 방 데이터, 쓰기 실패)에는 넉넉히 기다린다.
  }, oppNavigating === false ? OPPONENT_QUICK_MS : OPPONENT_GRACE_MS);
}

// 상대가 창을 껐을 때, 남아있는 쪽이 상대 자리를 비우고 채팅에 퇴장 알림을 남긴다.
// 방 전체를 다시 쓰는 트랜잭션은 필드 하나만 규칙에 걸려도 통째로 거부돼 정리가 실패하고,
// 그러면 남은 사람이 전투 화면에 갇힌다. 이 시점에는 방에 나 혼자뿐이라 경합이 없으므로
// 바뀌는 값만 골라 쓴다.
async function handleOpponentLeft() {
  const room = currentRoom || {};
  const oppUid = isHost ? room.guestUid : room.hostUid;
  const oppName = (isHost ? room.guestName : room.hostName) || "상대방";
  const stillGone = isHost ? room.guestOnline === false : room.hostOnline === false;

  // 알림을 띄우는 사이에 상대가 돌아왔다면(순간적인 연결 끊김) 아무것도 건드리지 않는다.
  // 방 데이터가 다시 도착하면 전투 화면도 원래대로 돌아온다.
  if (!oppUid || !stillGone) {
    leaveAnnounced = false;
    return;
  }

  const updates = {
    guestUid: null,
    guestName: null,
    guestAvatar: null,
    guestUnits: null,
    guestReady: false,
    guestOnline: null,
    guestChatSince: null,
    guestNavigating: null,
    guestTyping: null,
    hostTyping: null,
    hostReady: false,
    playerCount: 1,
    status: "waiting",
    battle: null,
    matchEndPending: null,
    chat: null // 예전 구조로 방 안에 남아있던 기록 정리
  };

  if (!isHost) {
    // 방장이 나갔다면 내가 방장이 된다 (보던 채팅 범위도 그대로 가져간다).
    updates.hostUid = myUid;
    updates.hostName = room.guestName;
    updates.hostAvatar = room.guestAvatar;
    updates.hostUnits = room.guestUnits || null;
    updates.hostOnline = true;
    updates.hostChatSince = room.guestChatSince || null;
    updates.hostNavigating = null;
  }

  // 방과 채팅은 서로 다른 곳에 있으므로 최상위 기준 경로로 모아 한 번에 쓴다.
  const rootUpdates = {};
  Object.keys(updates).forEach((k) => { rootUpdates[`rooms/${roomId}/${k}`] = updates[k]; });

  if (!isLastLeaveNotice(oppUid)) {
    const noticeKey = newChatKey(db, roomId);
    rootUpdates[`chats/${roomId}/${noticeKey}`] = noticeEntry("leave", oppUid, oppName);
    Object.assign(rootUpdates, trimRootUpdates(roomId, noticeKey));
  }

  presenceRole = null;

  for (let i = 0; i < 5; i++) {
    try {
      await update(ref(db), rootUpdates);
      return;
    } catch (err) {
      console.error(`상대 이탈 정리 ${i + 1}번째 실패:`, err);
      await wait(1200);
    }
  }

  // 그래도 안 되면 최소한 이 사람은 전투 화면에서 빠져나가게 한다.
  pushNotice("방을 정리하지 못했습니다. 대기실로 돌아갑니다.");
  goRoom();
}

