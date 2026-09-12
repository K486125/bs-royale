import { firebaseConfig } from "./firebase-config.js";
import { unitFrameClass } from "./unit-colors.js";
import { maxHp, attackOf, damageAt } from "./unit-stats.js";
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
const MAX_TURNS = 10;          // 이만큼 돌면 매치 종료
const MOVES_PER_TURN = 3;      // 한 차례에 쓸 수 있는 행위 횟수 (이동/공격/재장전을 섞어 쓴다)
const MAX_AMMO = 3;            // 유닛마다 가지는 탄창 수
// 한 칸 움직인 뒤 이만큼은 다음 이동을 받지 않는다.
// 연속으로 밀어 넣으면 서버에 반영되기 전 상태로 다음 이동을 계산하게 되어 어긋날 수 있다.
const MOVE_COOLDOWN_MS = 1000;
const BOUNCE_DELAY_MS = 1000;   // 005의 튕김이 옆 적에게 닿기까지
const BURN_VISIBLE_MS = 3400;   // 006이 붙인 불이 남아 있는 시간

const TURN_IDLE_MS = 20000;    // 이 시간 동안 아무 것도 안 하면 매치가 끊긴다
// 개발 중에는 방치 감지를 꺼둔다. 상대가 이동을 마칠 때까지 그냥 기다린다.
// 다시 켜려면 이 값만 true로 바꾸면 된다.
const IDLE_TIMEOUT_ENABLED = false;
const ATTACK_FLASH_MS = 520;   // 공격한 뒤 사거리를 잠깐 남겨두는 시간
const PLAY_INTRO_MS = 900;     // 카운트다운 뒤 전투 화면으로 넘어가기 전 짧은 로딩
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
let turnInterval = null;
// 조작 중인 유닛은 칸이 아니라 번호(0,1,2)로 기억한다.
// 칸으로 기억하면 한 칸 움직이는 순간 그 칸이 비어서 선택이 풀려버린다.
let activeSlot = null;
let sharedSelection = null; // 방 데이터에 적어둔 내 선택 (상대 화면에 표시하기 위함)
let actionMode = null;     // 그 유닛으로 무엇을 할지: "move" | "attack"
let aimDir = null;         // 공격 조준 방향 (방향키로 정하고 엔터로 쏜다)
let attackFlash = null;    // 방금 쏜 사거리 (바로 지우지 않고 잠깐 남겨 사라지는 모습을 보여준다)
let matchFinished = false; // 정상 종료로 대기실에 돌아가는 중인지 (상대 이탈과 구분)

const loadingOverlay = document.getElementById("loading-overlay");
const battleMain = document.getElementById("battle-main");
const sidebarEl = document.getElementById("unit-slots");
const sidebarBoxEl = document.getElementById("unit-sidebar");
const countdownOverlay = document.getElementById("countdown-overlay");
const countdownNumberEl = document.getElementById("countdown-number");
const autoPlaceBtn = document.getElementById("auto-place");
const enemySidebarEl = document.getElementById("enemy-sidebar");
const enemySlotsEl = document.getElementById("enemy-slots");
const mapEl = document.getElementById("battle-map");
const timerEl = document.getElementById("placement-timer");
const matchEndOverlay = document.getElementById("match-end-overlay");
const matchEndTextEl = matchEndOverlay.querySelector(".match-end-text");
const turnBarEl = document.getElementById("turn-bar");
const turnActionsEl = document.getElementById("turn-actions");
const actMoveBtn = document.getElementById("act-move");
const actAttackBtn = document.getElementById("act-attack");
const actReloadBtn = document.getElementById("act-reload");
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
// 판 좌표의 행이 화면에서 몇 번째 줄인지 (게스트 화면은 세로로 뒤집혀 있다)
function displayRow(r) {
  return isHost ? r : ROWS - 1 - r;
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
      tile.style.gridRowStart = displayRow(r) + 1;
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
      <span class="key-badge">${i + 1}</span>
      <div class="unit-tile ${unitFrameClass(file)}">
        <img src="${AVATAR_PATH}${file}" alt="">
      </div>
    `;

    // 사이드바에서 유닛을 고르는 것만으로는 소리를 내지 않는다.
    // 효과음은 실제로 타일에 배치했을 때만 난다 (onTileClick 참고).
    if (!isPlaced && !myDone) {
      card.addEventListener("click", () => selectUnitSlot(i));
    }
    sidebarEl.appendChild(card);
  }
}

// 사이드바 클릭과 숫자 키가 같은 길을 쓰도록 한 곳에 모은다.
function selectUnitSlot(slot) {
  const battle = currentRoom && currentRoom.battle;
  if (!battle) return;

  // 진행 중에는 그 번호의 유닛이 서 있는 칸을 찾아서 고른다.
  if (battle.phase === "playing") {
    const mine = battle[battleField()] || {};
    const key = Object.keys(mine).find((k) => mine[k] && mine[k].slot === slot);
    if (key) selectUnitAt(key);
    return;
  }

  if (battle.phase !== "placing" || myDone) return;
  if (!myUnits[slot]) return;

  const myPlacements = battle[battleField()] || {};
  if (placedSlotSet(myPlacements).has(slot)) return; // 이미 놓은 유닛

  selectedSlot = (selectedSlot === slot) ? null : slot;
  renderSidebar(myPlacements);
}

// 1, 2, 3 키로 유닛을 고르고, W 키로 이동을 고른다.
// 같은 키를 다시 누르면 선택이 풀린다.
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;

  const slot = ["1", "2", "3"].indexOf(e.key);
  if (slot !== -1) {
    selectUnitSlot(slot);
    return;
  }

  // 한글 입력 상태에서도 같은 자리의 키가 먹도록 e.code를 함께 본다.
  if (e.code === "KeyW" || (e.key || "").toLowerCase() === "w") chooseMove();
  else if (e.code === "KeyA" || (e.key || "").toLowerCase() === "a") chooseAttack();
  else if (e.code === "KeyS" || (e.key || "").toLowerCase() === "s") doReload();
});

// ---------- 자동 배치 (개발/테스트용) ----------
// 켜두면 배치 단계가 시작되는 순간 내 유닛을 내 진영 빈칸에 무작위로 한 번에 놓는다.
// 배치가 끝나면 평소처럼 자동으로 "배치 완료"까지 이어진다.
const AUTO_PLACE_KEY = "bs_auto_place";
let autoPlace = localStorage.getItem(AUTO_PLACE_KEY) === "1";
let autoPlaceInFlight = false;

function renderAutoPlaceBtn() {
  autoPlaceBtn.classList.toggle("on", autoPlace);
  autoPlaceBtn.setAttribute("aria-pressed", String(autoPlace));
}

autoPlaceBtn.addEventListener("click", () => {
  if (autoPlaceInFlight) return; // 놓는 중에는 다시 받지 않는다
  autoPlace = !autoPlace;
  localStorage.setItem(AUTO_PLACE_KEY, autoPlace ? "1" : "0");
  renderAutoPlaceBtn();
  // 배치 단계 도중에 켰다면 기다리지 않고 바로 놓아준다.
  if (autoPlace && currentRoom && currentRoom.battle) {
    maybeAutoPlace(currentRoom.battle[battleField()] || {});
  }
});
renderAutoPlaceBtn();

function maybeAutoPlace(myPlacements) {
  if (!autoPlace || autoPlaceInFlight || myDone || doneRequested) return;

  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "placing") return;

  const placed = placedSlotSet(myPlacements);
  const slots = [0, 1, 2].filter((i) => myUnits[i] && !placed.has(i));
  if (!slots.length) return;

  // 내 진영에서 아직 비어 있는 칸을 모아 섞는다.
  const free = [];
  for (let r = 0; r < ROWS; r++) {
    if (r === BOUNDARY_ROW || !isMyAreaRow(r)) continue;
    for (let c = 0; c < COLS; c++) {
      if (!myPlacements[`${r}_${c}`]) free.push(`${r}_${c}`);
    }
  }
  if (free.length < slots.length) return;
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }

  const updates = {};
  slots.forEach((slot, i) => { updates[free[i]] = { slot, file: myUnits[slot] }; });

  autoPlaceInFlight = true;
  selectedSlot = null;
  playSelect();
  update(ref(db, `rooms/${roomId}/battle/${battleField()}`), updates)
    .catch((err) => console.error("자동 배치 실패:", err))
    .finally(() => { autoPlaceInFlight = false; });
}

// ---------- 맵 타일 렌더링 ----------
function renderMapTiles(myPlacements, oppPlacements) {
  const battle = (currentRoom && currentRoom.battle) || {};
  const playing = battle.phase === "playing";
  mapEl.classList.toggle("playing", playing);

  // 상대가 지금 고른 유닛 (상대 차례일 때만 보여준다)
  const oppSelected = playing && battle.active !== myRole()
    ? battle[isHost ? "guestSelected" : "hostSelected"]
    : null;

  const selected = activeTile(battle);
  const burning = new Set(burningKeys(battle));

  mapEl.querySelectorAll(".tile").forEach((tile) => {
    const key = `${tile.dataset.row}_${tile.dataset.col}`;
    const mine = myPlacements[key];
    const placement = mine || oppPlacements[key];

    tile.classList.toggle("occupied", !!placement);
    tile.classList.toggle("unit-selected", !!selected && key === selected);
    tile.classList.toggle("mine-unit", !!mine);
    tile.classList.toggle("enemy-unit", !!placement && !mine);

    tile.innerHTML = placement
      ? `<div class="tile-unit-frame ${unitFrameClass(placement.file)}"><img src="${AVATAR_PATH}${placement.file}" alt=""></div>`
      : "";

    // 타고 있는 자리에는 불꽃을 그린다. 서 있는 유닛 그림 위에서 흔들린다.
    if (burning.has(key)) {
      const fire = document.createElement("div");
      fire.className = "burn-fx";
      fire.innerHTML = `<i class="fl fl-a"></i><i class="fl fl-b"></i><i class="fl fl-c"></i><i class="ember"></i>`;
      tile.appendChild(fire);
    }

    // 곧 튕겨 맞을 적에게는 느낌표를 띄워, 피해가 닿기 전에 알아볼 수 있게 한다.
    // 표시는 방 데이터에 있으므로 쏜 쪽과 맞는 쪽 모두에게 같이 보인다.
    if (placement && key === bounceMarkKey(battle)) {
      const warn = document.createElement("div");
      warn.className = "bounce-warn";
      warn.textContent = "!";
      tile.appendChild(warn);
    }

    // 상대가 움직이려는 유닛에는 네 방향 화살표를 그 칸 안에 모아 표시한다.
    if (placement && !mine && key === oppSelected) {
      const mark = document.createElement("div");
      mark.className = "opp-active-mark";
      mark.innerHTML = `<i class="a-up"></i><i class="a-down"></i><i class="a-left"></i><i class="a-right"></i>`;
      tile.appendChild(mark);
    }
  });
}

// 튕김 예고 표시. 쏜 쪽이 적어두고 1초 뒤 지우는데,
// 도중에 창이 닫혀 남는 일이 없도록 시간이 너무 지난 표시는 무시한다.
function bounceMarkKey(battle) {
  const mark = battle && battle.bounceMark;
  if (!mark || !mark.key) return null;
  const at = mark.at || 0;
  if (at && serverNow() - at > BOUNCE_DELAY_MS + 1500) return null;
  return mark.key;
}

// 고른 유닛 주변에 "갈 수 있는 방향"만 화살표로 표시한다.
// 화살표는 화면 기준이라, 판이 뒤집혀 보이는 게스트에서도 누를 방향과 그림이 일치한다.
const ARROW_CLASS = {
  ArrowUp: "move-up", ArrowDown: "move-down", ArrowLeft: "move-left", ArrowRight: "move-right"
};

function renderMoveHints(battle) {
  mapEl.querySelectorAll(".tile").forEach((tile) => {
    tile.classList.remove("move-hint", "move-up", "move-down", "move-left", "move-right");
  });

  // 이동을 고른 뒤에만 화살표를 보여준다 (고르기만 했을 때는 아무것도 표시하지 않는다).
  if (!battle || battle.phase !== "playing" || !isMyTurn(battle)) return;
  if (actionMode !== "move") return;
  if (moveInFlight || onActionCooldown()) return; // 아직 다음 행동을 받지 않는 동안

  const from = activeTile(battle);
  if (!from) return;

  Object.keys(ARROW_CLASS).forEach((key) => {
    const target = stepTarget(battle, from, screenDirection(key));
    if (!target) return; // 판 밖이거나 누가 서 있는 방향에는 화살표를 그리지 않는다
    const { r, c } = parseTile(target);
    const tile = mapEl.querySelector(`.tile[data-row="${r}"][data-col="${c}"]`);
    if (tile) tile.classList.add("move-hint", ARROW_CLASS[key]);
  });
}

// 사거리 표시: 자기 칸부터 사거리 끝까지를 하나의 직사각형으로 덮는다.
// 맵이 격자라서, 격자 칸 범위를 지정한 덮개를 올리면 칸 사이 틈까지 이어진 하나의 네모가 된다.
function rangeBox(fromKey, tiles, aimed) {
  const cells = [parseTile(fromKey)].concat(tiles.map((t) => parseTile(t.key)));
  const rows = cells.map((p) => displayRow(p.r));
  const cols = cells.map((p) => p.c);

  const box = document.createElement("div");
  box.className = "range-box" + (aimed ? " aimed" : "");
  box.style.gridRowStart = Math.min.apply(null, rows) + 1;
  box.style.gridRowEnd = Math.max.apply(null, rows) + 2;
  box.style.gridColumnStart = Math.min.apply(null, cols) + 1;
  box.style.gridColumnEnd = Math.max.apply(null, cols) + 2;
  return box;
}

function renderAttackRange(battle) {
  mapEl.querySelectorAll(".range-box").forEach((el) => el.remove());
  if (!battle || battle.phase !== "playing") return;

  // 공격이 나간 직후에는 조준했던 자리를 잠깐 남겨 서서히 사라지게 한다.
  // (쏘자마자 뚝 사라지면 어디로 쐈는지 확인할 틈이 없다)
  if (attackFlash) {
    if (Date.now() < attackFlash.until) {
      const box = rangeBox(attackFlash.fromKey, attackFlash.tiles, true);
      box.classList.add("fading");
      mapEl.appendChild(box);
    }
    return;
  }

  // 그 밖에는 공격을 고른 뒤에만 사거리를 보여준다.
  if (!isMyTurn(battle) || actionMode !== "attack") return;

  const from = activeTile(battle);
  const unit = myUnitAt(battle, from);
  if (!unit || !attackOf(unit.file)) return;

  // 아직 조준 전이면 네 방향을 모두, 조준했으면 그 방향만 진하게 보여준다.
  const keys = aimDir ? [aimDir] : Object.keys(DIRECTIONS);
  keys.forEach((key) => {
    const tiles = attackTiles(from, key, unit.file);
    if (tiles.length) mapEl.appendChild(rangeBox(from, tiles, aimDir === key));
  });
}

function onTileClick(e) {
  const tile = e.target.closest(".tile");
  if (!tile) return;

  const battle = currentRoom && currentRoom.battle;
  if (battle && battle.phase === "playing") {
    selectUnitAt(`${tile.dataset.row}_${tile.dataset.col}`);
    return;
  }

  if (myDone || selectedSlot === null) return;

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
  const battle = currentRoom && currentRoom.battle;
  if (myDone || !battle || battle.phase !== "placing") return;

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

// ---------- 카운트다운 (3,2,1,0에서 멈춤 - 이후 게임 로직은 아직 없음) ----------
function renderCountdown(battle) {
  clearInterval(countdownInterval);

  if (battle.phase !== "countdown" || !battle.countdownStartedAt) {
    countdownOverlay.classList.add("hidden");
    return;
  }
  countdownOverlay.classList.remove("hidden");

  if (!serverTimeReady()) {
    countdownNumberEl.textContent = "3";
    whenServerTime(() => {
      if (currentRoom && currentRoom.battle) renderCountdown(currentRoom.battle);
    });
    return;
  }

  const tick = () => {
    const remain = Math.max(0, 3000 - (serverNow() - battle.countdownStartedAt));
    const n = Math.ceil(remain / 1000);
    countdownNumberEl.textContent = String(n);
    if (remain <= 0) {
      clearInterval(countdownInterval);
      // 방장이 대표로 첫 턴을 연다. 어떤 이유로 기록되지 않으면 상대도 카운트다운 0에서
      // 멈춰 있게 되므로, 몇 초 뒤에는 남은 쪽이 대신 연다.
      if (isHost) {
        startPlaying();
      } else {
        setTimeout(() => {
          const b = currentRoom && currentRoom.battle;
          if (b && b.phase === "countdown") startPlaying();
        }, 4000);
      }
    }
  };
  tick();
  countdownInterval = setInterval(tick, 100);
}

// ---------- 턴제 진행 ----------
// 한 차례에 이동 3번. 다 쓰면 상대 차례가 되고, 둘 다 마치면 한 턴이 끝난다.
// 값은 모두 방 데이터에 들어 있어서 양쪽 화면이 같은 상태를 본다.
const myRole = () => (isHost ? "host" : "guest");

function isMyTurn(battle) {
  return !!battle && battle.phase === "playing" && battle.active === myRole();
}

// 카운트다운이 끝나면 방장이 대표로 첫 턴을 연다.
let playStartRequested = false;
async function startPlaying() {
  if (playStartRequested) return;
  playStartRequested = true;
  try {
    // 캐릭터마다 기본 체력이 다르므로, 실제로 배치된 유닛을 보고 채운다.
    const battle = (currentRoom && currentRoom.battle) || {};
    const fullHp = (placements) => {
      const table = {};
      Object.values(placements || {}).forEach((u) => {
        if (u) table[u.slot ?? 0] = maxHp(u.file);
      });
      return table;
    };
    await update(ref(db, `rooms/${roomId}/battle`), {
      phase: "playing",
      turn: 1,
      active: "host", // 방장이 먼저 움직인다
      movesLeft: MOVES_PER_TURN,
      actedAt: serverTimestamp(),
      hostHp: fullHp(battle.hostPlacements),
      guestHp: fullHp(battle.guestPlacements),
      hostAmmo: { 0: MAX_AMMO, 1: MAX_AMMO, 2: MAX_AMMO },
      guestAmmo: { 0: MAX_AMMO, 1: MAX_AMMO, 2: MAX_AMMO },
      hostPending: { 0: 0, 1: 0, 2: 0 },
      guestPending: { 0: 0, 1: 0, 2: 0 }
    });
  } catch (err) {
    console.error("턴 시작 실패:", err);
    playStartRequested = false;
  }
}

// 지금 조작 중인 유닛이 서 있는 칸. 움직이면 이 값만 따라 바뀐다.
function activeTile(battle) {
  if (activeSlot === null || !battle) return null;
  const mine = battle[battleField()] || {};
  return Object.keys(mine).find((k) => mine[k] && mine[k].slot === activeSlot) || null;
}

function tileKey(r, c) { return `${r}_${c}`; }
function parseTile(key) {
  const [r, c] = key.split("_").map(Number);
  return { r, c };
}

// 누군가 서 있는 칸인지 (내 유닛이든 상대 유닛이든 막힌다)
function oppField() {
  return isHost ? "guestPlacements" : "hostPlacements";
}

function occupant(battle, key) {
  const mine = battle[battleField()] || {};
  const opp = battle[isHost ? "guestPlacements" : "hostPlacements"] || {};
  return mine[key] || opp[key] || null;
}

// 판 좌표 기준 방향 (행이 커질수록 아래)
const DIRECTIONS = {
  ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1]
};

// 게스트 화면은 자기 진영이 늘 아래쪽에 오도록 세로로 뒤집어 그린다(buildMap 참고).
// 그래서 게스트가 위를 누르면 판 좌표로는 행이 커지는 쪽으로 가야 화면에서 위로 올라간다.
// 좌우는 뒤집지 않으므로 그대로 둔다.
function screenDirection(key) {
  const dir = DIRECTIONS[key];
  if (!dir) return null;
  return isHost ? dir : [-dir[0], dir[1]];
}

// 그 방향으로 한 칸 갈 수 있는지 본다. 판 밖이거나 누가 서 있으면 못 간다.
// 가운데 경계선은 배치 때만 막히고, 이동할 때는 넘어갈 수 있다.
function stepTarget(battle, fromKey, dir) {
  const [dr, dc] = dir;
  const { r, c } = parseTile(fromKey);
  const nr = r + dr;
  const nc = c + dc;
  if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return null;
  const key = tileKey(nr, nc);
  if (occupant(battle, key)) return null;
  return key;
}

function hasAnyMove(battle) {
  const mine = battle[battleField()] || {};
  return Object.keys(mine).some((key) =>
    Object.values(DIRECTIONS).some((d) => stepTarget(battle, key, d))
  );
}

// 한 칸 이동. 남은 횟수가 0이 되면 차례가 넘어간다.
let moveInFlight = false;
let attackInFlight = false;
let reloadInFlight = false;
// 이 시각 전에는 다음 행동(이동/공격)을 받지 않는다.
// 경과 시간만 보므로 PC 시계가 어긋나 있어도 정확하다.
let actionReadyAt = 0;

function onActionCooldown() {
  return Date.now() < actionReadyAt;
}

// 쓰기가 오가는 중이면 새 행동을 받지 않는다 (연타로 같은 행동이 두 번 나가는 것을 막는다).
function actionBusy() {
  return moveInFlight || attackInFlight || reloadInFlight || onActionCooldown();
}

// 한 번 행동한 뒤 잠시 쉬고, 쉬는 시간이 끝나면 화면을 다시 그려 표시를 되살린다.
function startActionCooldown() {
  actionReadyAt = Date.now() + MOVE_COOLDOWN_MS;
  setTimeout(() => {
    if (currentRoom && currentRoom.battle) renderBattle(currentRoom);
  }, MOVE_COOLDOWN_MS);
}

async function moveUnit(fromKey, dir) {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || actionBusy() || !isMyTurn(battle)) return;

  const mine = battle[battleField()] || {};
  const unit = mine[fromKey];
  if (!unit) return;

  const toKey = stepTarget(battle, fromKey, dir);
  if (!toKey) {
    // 판 밖이거나 그 방향에 누가 서 있다 (내 유닛이든 상대 유닛이든 막힌다)
    pushNotice("실패: 해당 방향으로\n이동할 수 없습니다.", { group: "move", duration: 1800 });
    return;
  }

  const left = Math.max(0, (battle.movesLeft || 0) - 1);
  const field = battleField();
  const updates = {
    [`${field}/${fromKey}`]: null,
    [`${field}/${toKey}`]: { slot: unit.slot, file: unit.file },
    movesLeft: left,
    actedAt: serverTimestamp()
  };
  Object.assign(updates, turnHandoverUpdates(battle, left));

  // 선택은 번호로 잡고 있으므로, 칸이 바뀌어도 같은 유닛을 계속 조작한다.
  // 이동 준비(W)도 그대로 유지되어 방향키만 다시 누르면 이어서 움직인다.
  moveInFlight = true;
  playSelect();
  try {
    await update(ref(db, `rooms/${roomId}/battle`), updates);
    // 쉬는 동안에는 화살표를 감췄다가, 끝나면 다시 그려서 "이제 움직일 수 있다"를 보여준다.
    startActionCooldown();
  } catch (err) {
    console.error("이동 실패:", err);
    writeFailNotice("이동", err);
  } finally {
    moveInFlight = false;
  }
}

// 남은 이동이 0이면 다음 차례로 넘긴다. 게스트까지 마치면 한 턴이 끝난다.
function turnHandoverUpdates(battle, movesLeft) {
  if (movesLeft > 0) return {};

  if (battle.active === "host") {
    return { active: "guest", movesLeft: MOVES_PER_TURN };
  }

  const nextTurn = (battle.turn || 1) + 1;
  if (nextTurn > MAX_TURNS) {
    return { phase: "finished", endReason: "turns", finishedAt: serverTimestamp() };
  }

  // 턴이 하나 오를 때마다 양쪽 모든 유닛에게 재장전 거리가 하나씩 쌓인다.
  const refill = {};
  ["host", "guest"].forEach((role) => {
    for (let slot = 0; slot < 3; slot++) {
      refill[`${role}Pending/${slot}`] = Math.min(MAX_AMMO, pendingOf(battle, role, slot) + 1);
    }
  });

  return { ...refill, turn: nextTurn, active: "host", movesLeft: MOVES_PER_TURN };
}

// 어느 방향으로도 못 움직이는 상황이면(둘러싸임) 차례가 영영 안 넘어가므로 넘겨준다.
let stuckPassInFlight = false;
async function passIfStuck(battle) {
  if (stuckPassInFlight || actionBusy()) return;
  if (!isMyTurn(battle)) return;
  // 때릴 수 있는 적이 있으면 움직이지 못해도 할 일이 남아 있다.
  if (hasAnyMove(battle) || hasAnyAttack(battle)) return;
  stuckPassInFlight = true;
  try {
    await update(ref(db, `rooms/${roomId}/battle`), {
      movesLeft: 0,
      actedAt: serverTimestamp(),
      ...turnHandoverUpdates(battle, 0)
    });
    pushNotice("할 수 있는 행위가 없어 차례를 넘깁니다.");
  } catch (err) {
    console.error("차례 넘기기 실패:", err);
  } finally {
    stuckPassInFlight = false;
  }
}

// 방치 감지. 차례인 사람이 20초 동안 아무 것도 하지 않으면 매치를 끝낸다.
// 차례가 아닌 쪽도 함께 감시해서, 상대 앱이 멈춰 있어도 둘 다 대기실로 돌아갈 수 있게 한다.
let idleEndRequested = false;
async function endByIdle() {
  if (idleEndRequested) return;
  idleEndRequested = true;
  try {
    await update(ref(db, `rooms/${roomId}/battle`), {
      phase: "finished",
      endReason: "timeout",
      finishedAt: serverTimestamp()
    });
  } catch (err) {
    console.error("시간 초과 처리 실패:", err);
    idleEndRequested = false;
  }
}

// 내가 어떤 유닛을 움직이려는지 상대도 볼 수 있도록 방 데이터에 적어둔다.
// 값이 바뀔 때만 쓴다 (화면을 다시 그릴 때마다 쓰면 쓸데없이 오간다).
function shareSelection(key) {
  const next = key || null;
  if (sharedSelection === next) return;
  sharedSelection = next;
  update(ref(db, `rooms/${roomId}/battle`), { [`${myRole()}Selected`]: next })
    .catch((err) => console.error("선택 표시 실패:", err));
}

// 조작할 유닛을 고른다. 고르기만 해서는 아무 일도 일어나지 않고,
// 이동인지 공격인지 한 번 더 선택해야 한다.
// 빠르게 여러 번 누르면 선택이 켜졌다 꺼졌다 하며 방 데이터에 쓰기가 몰린다.
// 아주 짧은 간격의 반복은 무시한다.
const SELECT_GAP_MS = 160;
let lastSelectAt = 0;

function selectUnitAt(key) {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing") return;
  if (moveInFlight || attackInFlight) return;

  const now = Date.now();
  if (now - lastSelectAt < SELECT_GAP_MS) return;
  lastSelectAt = now;
  if (!isMyTurn(battle)) {
    pushNotice("상대 차례입니다.", { group: "turn", duration: 1400 });
    return;
  }
  const mine = battle[battleField()] || {};
  if (!mine[key]) return;

  const slot = mine[key].slot ?? 0;
  // 같은 유닛을 다시 누르면 해제, 다른 유닛을 고르면 이동 준비는 처음부터 다시.
  activeSlot = (activeSlot === slot) ? null : slot;
  actionMode = null;
  aimDir = null;
  renderBattle(currentRoom);
}

function chooseMove() {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing") return;
  if (actionMode === "move") return;      // 이미 고른 상태면 다시 그리지 않는다
  if (moveInFlight || attackInFlight) return; // 쓰기가 오가는 중에는 바꾸지 않는다

  if (!isMyTurn(battle)) {
    pushNotice("상대 차례입니다.", { group: "turn", duration: 1400 });
    return;
  }
  if (activeSlot === null) {
    pushNotice("움직일 유닛을 먼저 고르세요.", { group: "turn", duration: 1600 });
    return;
  }
  actionMode = "move";
  aimDir = null;
  renderBattle(currentRoom);
}

actMoveBtn.addEventListener("click", chooseMove);
actAttackBtn.addEventListener("click", chooseAttack);
actReloadBtn.addEventListener("click", doReload);

// 방향키로 한 칸씩 움직인다.
window.addEventListener("keydown", (e) => {
  if (e.repeat) return; // 누르고 있어도 한 번만 (한 칸씩 눌러서 움직인다)

  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing") return;

  // 엔터는 조준한 방향으로 실제 공격을 내보낸다.
  if (e.key === "Enter") {
    e.preventDefault();
    fireAttack();
    return;
  }

  const dirKey = DIRECTIONS[e.key] ? e.key : null;
  if (!dirKey) return;
  e.preventDefault(); // 방향키로 화면이 스크롤되지 않도록

  if (!isMyTurn(battle)) {
    pushNotice("상대 차례입니다.", { group: "turn", duration: 1400 });
    return;
  }
  const from = activeTile(battle);
  if (!from) {
    pushNotice("조작할 유닛을 먼저 고르세요.", { group: "turn", duration: 1600 });
    return;
  }

  // 공격 중이면 방향키는 조준만 한다 (쏘는 것은 엔터).
  if (actionMode === "attack") {
    aimAt(dirKey);
    return;
  }
  if (actionMode !== "move") {
    pushNotice("이동(W) 또는 공격(A)을 먼저 선택하세요.", { group: "turn", duration: 1600 });
    return;
  }
  moveUnit(from, screenDirection(dirKey));
});

// ---------- 체력 ----------
// 쓰기가 거부되면 화면에서는 "아무 일도 안 일어남"으로 보이기 때문에,
// 권한 거부(대개 데이터베이스 규칙이 아직 갱신되지 않은 경우)는 따로 알려준다.
function writeFailNotice(action, err) {
  const message = (err && (err.code || err.message) || "").toString().toLowerCase();
  const denied = message.includes("permission");
  pushNotice(denied ? `${action}하지 못했습니다.\n권한이 거부되었습니다.` : `${action}하지 못했습니다.`,
    { group: "write-fail", duration: 2400 });
}

function hpOf(battle, role, slot, file) {
  const table = battle[role === "host" ? "hostHp" : "guestHp"] || {};
  const value = table[slot];
  return typeof value === "number" ? value : maxHp(file);
}

// 남은 비율에 따라 초록 -> 노랑 -> 주황 -> 빨강.
function hpClass(ratio) {
  if (ratio > 0.6) return "";
  if (ratio > 0.35) return "warn";
  if (ratio > 0.15) return "low";
  return "critical";
}

// 숫자는 남은 체력만 보여준다 (1000 -> 670). 최대치는 적지 않는다.
// 바는 다시 그릴 때마다 새로 만들어지므로, 이전 값에서 시작해 두었다가
// 화면에 붙은 뒤 새 값으로 옮겨야 줄어드는 움직임이 보인다.
function hpBarHtml(hp, file, fromHp) {
  const max = maxHp(file);
  const ratio = Math.max(0, Math.min(1, hp / max));
  const start = fromHp === undefined ? ratio : Math.max(0, Math.min(1, fromHp / max));
  return `
    <div class="hp-bar ${hpClass(ratio)}">
      <div class="hp-fill" style="width: ${start * 100}%" data-target="${ratio * 100}"></div>
      <div class="hp-text">${Math.round(hp)}</div>
    </div>
  `;
}

// 붙여둔 목표 너비로 옮긴다. 사이 값을 확정시킨 뒤에 바꿔야 전환이 재생된다.
function animateHpBars(root) {
  root.querySelectorAll(".hp-fill[data-target]").forEach((fill) => {
    const target = fill.dataset.target;
    delete fill.dataset.target;
    void fill.offsetWidth;
    fill.style.width = `${target}%`;
  });
}

// ---------- 탄창 ----------
function ammoOf(battle, role, slot) {
  const table = battle[`${role}Ammo`] || {};
  const value = table[slot];
  return typeof value === "number" ? value : MAX_AMMO;
}

// 턴이 오를 때마다 쌓이는 재장전 거리. 이걸 한 번에 하나씩 탄창으로 옮긴다.
function pendingOf(battle, role, slot) {
  const table = battle[`${role}Pending`] || {};
  const value = table[slot];
  return typeof value === "number" ? value : 0;
}

// 유닛 그림 아래에 탄창을 칸으로 보여준다 (내 유닛만).
function ammoRowHtml(ammo) {
  let pips = "";
  for (let i = 0; i < MAX_AMMO; i++) {
    pips += `<i class="${i < ammo ? "loaded" : ""}"></i>`;
  }
  return `<div class="ammo-row">${pips}</div>`;
}

// ---------- 피해 표시 ----------
// 방 데이터가 올 때마다 직전 체력과 비교해서, 줄어든 유닛 위에 숫자를 띄운다.
// 쓰러져서 판에서 사라진 유닛도 직전 위치를 기억해 두었다가 그 자리에 띄운다.
let prevHp = null;   // { host: {slot: 체력}, guest: {...} }
let prevTile = { host: {}, guest: {} };

function hpSnapshot(battle) {
  const snap = { host: {}, guest: {} };
  ["host", "guest"].forEach((role) => {
    const placements = battle[`${role}Placements`] || {};
    Object.values(placements).forEach((unit) => {
      if (!unit) return;
      const slot = unit.slot ?? 0;
      snap[role][slot] = hpOf(battle, role, slot, unit.file);
    });
  });
  return snap;
}

function tileSnapshot(battle) {
  const snap = { host: {}, guest: {} };
  ["host", "guest"].forEach((role) => {
    const placements = battle[`${role}Placements`] || {};
    Object.keys(placements).forEach((key) => {
      const unit = placements[key];
      if (unit) snap[role][unit.slot ?? 0] = key;
    });
  });
  return snap;
}

// 줄어든 곳을 찾아 숫자를 띄운다. 처음 들어왔을 때는 비교 대상이 없으므로 띄우지 않는다.
function showDamage(battle) {
  const now = hpSnapshot(battle);
  const tiles = tileSnapshot(battle);

  if (prevHp) {
    ["host", "guest"].forEach((role) => {
      Object.keys(prevHp[role]).forEach((slot) => {
        const before = prevHp[role][slot];
        const after = now[role][slot] !== undefined ? now[role][slot] : 0;
        const damage = Math.round(before - after);
        if (damage <= 0) return;

        const key = tiles[role][slot] || prevTile[role][slot];
        if (key) spawnDamagePop(key, damage, role !== myRole());
      });
    });
  }

  prevHp = now;
  prevTile = tiles;
}

// mine=true 이면 내가 넣은 피해(흰색), false 이면 내가 받은 피해(빨간색).
function spawnDamagePop(key, damage, mine) {
  const { r, c } = parseTile(key);
  const pop = document.createElement("div");
  pop.className = "damage-pop" + (mine ? "" : " taken");
  pop.textContent = `-${damage}`;
  pop.style.gridRowStart = displayRow(r) + 1;
  pop.style.gridColumnStart = c + 1;
  mapEl.appendChild(pop);
  setTimeout(() => pop.remove(), 1200);
}

// ---------- 진행 중 화면 ----------
function renderTurnSidebar(myPlacements) {
  const battle = currentRoom.battle;
  sidebarEl.innerHTML = "";

  Object.entries(myPlacements)
    .sort((a, b) => (a[1].slot || 0) - (b[1].slot || 0))
    .forEach(([key, unit]) => {
      const card = document.createElement("div");
      card.className = "unit-slot-card with-hp" + (unit.slot === activeSlot ? " selected" : "");
      card.innerHTML = `
        <span class="key-badge">${(unit.slot ?? 0) + 1}</span>
        ${hpBarHtml(hpOf(battle, myRole(), unit.slot ?? 0, unit.file), unit.file, prevHp && prevHp[myRole()][unit.slot ?? 0])}
        <div class="unit-tile ${unitFrameClass(unit.file)}">
          <img src="${AVATAR_PATH}${unit.file}" alt="">
        </div>
        ${ammoRowHtml(ammoOf(battle, myRole(), unit.slot ?? 0))}
      `;
      card.addEventListener("click", () => selectUnitAt(key));
      sidebarEl.appendChild(card);
    });

  animateHpBars(sidebarEl);

  const canAct = activeSlot !== null && isMyTurn(battle);
  turnActionsEl.classList.toggle("hidden", !canAct);
  actMoveBtn.classList.toggle("on", actionMode === "move");
  actAttackBtn.classList.toggle("on", actionMode === "attack");
  // 공격 수치가 있고 탄창이 남은 유닛만 누를 수 있다.
  actAttackBtn.disabled = !canAttackNow(battle);

  // 재장전 버튼에는 지금 쌓여 있는 수를 함께 보여준다.
  const unit = myUnitAt(battle, activeTile(battle));
  const pending = unit ? pendingOf(battle, myRole(), unit.slot ?? 0) : 0;
  actReloadBtn.textContent = pending > 0 ? `재장전 (S) ${pending}` : "재장전 (S)";
  actReloadBtn.disabled = !canReloadNow(battle);
}

// 오른쪽 사이드바: 상대 유닛의 상태만 보여준다 (고를 수 없고 단축키도 없다).
function renderEnemySidebar(battle, oppPlacements) {
  const playing = battle.phase === "playing";
  enemySidebarEl.classList.toggle("hidden", !playing);
  if (!playing) return;

  const oppRole = isHost ? "guest" : "host";
  enemySlotsEl.innerHTML = "";

  Object.values(oppPlacements)
    .sort((a, b) => (a.slot || 0) - (b.slot || 0))
    .forEach((unit) => {
      const card = document.createElement("div");
      card.className = "unit-slot-card";
      card.innerHTML = `
        ${hpBarHtml(hpOf(battle, oppRole, unit.slot ?? 0, unit.file), unit.file, prevHp && prevHp[oppRole][unit.slot ?? 0])}
        <div class="unit-tile ${unitFrameClass(unit.file)}">
          <img src="${AVATAR_PATH}${unit.file}" alt="">
        </div>
      `;
      enemySlotsEl.appendChild(card);
    });

  animateHpBars(enemySlotsEl);
}

// 위쪽 띠: 몇 턴째인지, 누구 차례인지, 이동이 몇 번 남았는지, 방치까지 몇 초 남았는지.
function renderTurnBar(battle) {
  clearInterval(turnInterval);

  if (!battle || battle.phase !== "playing") {
    turnBarEl.classList.add("hidden");
    return;
  }
  turnBarEl.classList.remove("hidden");

  const mine = isMyTurn(battle);
  turnBarEl.classList.toggle("mine", mine);

  const head = `턴 ${battle.turn || 1}/${MAX_TURNS} · ${mine ? "내 차례" : "상대 차례"}`;
  const moves = `${mine ? "행위" : "상대 행위"} ${battle.movesLeft ?? MOVES_PER_TURN}회 남음`;

  // 방치 감지를 꺼둔 동안에는 남은 시간을 세지 않고, 상대가 마칠 때까지 기다린다.
  if (!IDLE_TIMEOUT_ENABLED) {
    turnBarEl.textContent = `${head} · ${moves}`;
    return;
  }

  // 서버 시각을 모르거나 아직 첫 기록이 없으면 남은 시간을 셈하지 않는다
  // (시계가 어긋난 PC에서 시작하자마자 시간 초과가 되는 것을 막는다).
  if (!serverTimeReady() || !battle.actedAt) {
    turnBarEl.textContent = `${head} · ${moves}`;
    whenServerTime(() => {
      if (currentRoom && currentRoom.battle) renderTurnBar(currentRoom.battle);
    });
    return;
  }

  const tick = () => {
    const left = Math.max(0, TURN_IDLE_MS - (serverNow() - battle.actedAt));
    turnBarEl.textContent = `${head} · ${moves} · ${Math.ceil(left / 1000)}s`;
    if (left <= 0) {
      clearInterval(turnInterval);
      endByIdle();
    }
  };
  tick();
  turnInterval = setInterval(tick, 200);
}

// ---------- 공격 ----------
// 조준한 방향으로 사거리만큼의 칸 (판 밖은 빼고, 자기 칸은 포함하지 않는다).
function attackTiles(fromKey, dirKey, file) {
  const spec = attackOf(file);
  const dir = screenDirection(dirKey);
  if (!spec || !dir || !fromKey) return [];

  const { r, c } = parseTile(fromKey);
  const tiles = [];
  for (let d = 1; d <= spec.range; d++) {
    const nr = r + dir[0] * d;
    const nc = c + dir[1] * d;
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
    tiles.push({ key: tileKey(nr, nc), distance: d });
  }
  return tiles;
}

// 어떤 칸을 둘러싼 여덟 칸 (대각선까지, 판 안쪽만)
const AROUND = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1]
];
function neighborTiles(key) {
  const { r, c } = parseTile(key);
  return AROUND
    .map(([dr, dc]) => ({ r: r + dr, c: c + dc }))
    .filter((p) => p.r >= 0 && p.r < ROWS && p.c >= 0 && p.c < COLS)
    .map((p) => tileKey(p.r, p.c))
    .filter((k) => k !== key);
}

function myUnitAt(battle, key) {
  const mine = battle[battleField()] || {};
  return key ? mine[key] : null;
}

// 행위 3회 안에서라면 같은 유닛이 몇 번이든 공격할 수 있다.
// 막는 것은 공격 수치가 없는 유닛, 탄창이 빈 경우, 사거리 안에 적이 없는 경우다.
function canAttackNow(battle) {
  const unit = myUnitAt(battle, activeTile(battle));
  if (!unit || !attackOf(unit.file)) return false;
  return ammoOf(battle, myRole(), unit.slot ?? 0) > 0;
}

// 쌓인 재장전이 있고 탄창이 아직 다 차지 않았을 때만 재장전할 수 있다.
function canReloadNow(battle) {
  const unit = myUnitAt(battle, activeTile(battle));
  if (!unit) return false;
  const slot = unit.slot ?? 0;
  return pendingOf(battle, myRole(), slot) > 0 && ammoOf(battle, myRole(), slot) < MAX_AMMO;
}

// 내 유닛 중 하나라도 지금 때릴 수 있는 적이 있는지 (차례를 넘길지 판단할 때 쓴다)
function hasAnyAttack(battle) {
  const mine = battle[battleField()] || {};
  const opp = battle[oppField()] || {};
  return Object.keys(mine).some((key) => {
    const unit = mine[key];
    if (!unit || !attackOf(unit.file)) return false;
    return Object.keys(DIRECTIONS).some((dirKey) =>
      attackTiles(key, dirKey, unit.file).some((t) => opp[t.key])
    );
  });
}

function chooseAttack() {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing") return;
  if (actionMode === "attack") return;
  if (moveInFlight || attackInFlight) return;

  if (!isMyTurn(battle)) {
    pushNotice("상대 차례입니다.", { group: "turn", duration: 1400 });
    return;
  }
  if (activeSlot === null) {
    pushNotice("공격할 유닛을 먼저 고르세요.", { group: "turn", duration: 1600 });
    return;
  }

  const unit = myUnitAt(battle, activeTile(battle));
  if (!unit || !attackOf(unit.file)) {
    pushNotice("이 유닛은 아직 공격할 수 없습니다.", { group: "attack", duration: 1800 });
    return;
  }
  if (ammoOf(battle, myRole(), unit.slot ?? 0) <= 0) {
    pushNotice("탄창이 비었습니다.\n재장전(S)이 필요합니다.", { group: "attack", duration: 2000 });
    return;
  }
  actionMode = "attack";
  aimDir = null;
  renderBattle(currentRoom);
}

// 방향키는 조준만 한다. 실제 공격은 엔터.
function aimAt(dirKey) {
  if (aimDir === dirKey) return; // 같은 방향을 다시 눌러도 다시 그리지 않는다
  const battle = currentRoom && currentRoom.battle;
  const from = activeTile(battle);
  const unit = myUnitAt(battle, from);
  if (!unit) return;

  if (!attackTiles(from, dirKey, unit.file).length) {
    pushNotice("공격할 수 없는 방향입니다.", { group: "attack", duration: 1800 });
    return;
  }
  aimDir = dirKey;
  renderBattle(currentRoom);
}

async function fireAttack() {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing" || actionBusy()) return;
  if (actionMode !== "attack" || !isMyTurn(battle)) return;

  if (!aimDir) {
    pushNotice("공격 방향을 먼저 정하세요.", { group: "attack", duration: 1600 });
    return;
  }

  const from = activeTile(battle);
  const unit = myUnitAt(battle, from);
  const spec = attackOf(unit && unit.file);
  if (!unit || !spec) return;

  // 광역이면 사거리 안의 적을 모두, 단일이면 가장 가까운 적 하나만 때린다.
  const opp = battle[oppField()] || {};
  const line = attackTiles(from, aimDir, unit.file);
  const inRange = line.filter((t) => opp[t.key]);
  const targets = spec.splash ? inRange : inRange.slice(0, 1);
  if (!targets.length) {
    pushNotice("범위 내에 적 유닛이 없습니다.", { group: "attack", duration: 1800 });
    return;
  }

  const slot = unit.slot ?? 0;
  const ammo = ammoOf(battle, myRole(), slot);
  if (ammo <= 0) {
    pushNotice("탄창이 비었습니다.\n재장전(S)이 필요합니다.", { group: "attack", duration: 2000 });
    return;
  }

  const oppRole = isHost ? "guest" : "host";
  const left = Math.max(0, (battle.movesLeft || 0) - 1);
  const updates = {
    movesLeft: left,
    actedAt: serverTimestamp(),
    [`${myRole()}Ammo/${slot}`]: ammo - 1
  };

  const hurt = (key, amount) => {
    const target = opp[key];
    if (!target) return;
    const targetSlot = target.slot ?? 0;
    const before = updates[`${oppRole}Hp/${targetSlot}`];
    const base = before === undefined ? hpOf(battle, oppRole, targetSlot, target.file) : before;
    const remaining = Math.max(0, base - amount);
    updates[`${oppRole}Hp/${targetSlot}`] = remaining;
    // 체력이 0이 된 유닛은 판에서 내린다.
    if (remaining === 0) updates[`${oppField()}/${key}`] = null;
  };

  targets.forEach((hit) => hurt(hit.key, damageAt(spec, hit.distance)));

  // 005처럼 튕기는 공격: 맞은 칸을 둘러싼 여덟 칸(대각선 포함) 중 적이 선 자리로 한 번 더 간다.
  // 옆에 적이 여럿이면 그중 무작위, 하나뿐이면 그 적, 아무도 없으면 튕길 곳이 없어 끝난다.
  let bounceTo = null;
  updates.bounceMark = null;   // 지난 표시는 지우고 시작한다
  // 006처럼 자리를 태우는 공격은 그 칸을 불붙은 자리로 적어둔다 (양쪽 화면에 불이 보인다)
  if (spec.dot && targets.length) updates[`burns/${targets[0].key}`] = serverTimestamp();
  if (spec.bounce && targets.length) {
    const hitKey = targets[0].key;
    const around = neighborTiles(hitKey).filter((key) => opp[key]);
    const pick = around.length > 1
      ? around[Math.floor(Math.random() * around.length)]
      : around[0];
    if (pick) {
      bounceTo = { key: pick, damage: Math.round(damageAt(spec, targets[0].distance) * spec.bounce) };
      // 첫 피해와 같은 순간에 표시가 뜨도록 같은 쓰기에 담는다.
      updates.bounceMark = { key: pick, at: serverTimestamp() };
    }
  }

  Object.assign(updates, turnHandoverUpdates(battle, left));

  attackInFlight = true;
  playSelect();
  try {
    await update(ref(db, `rooms/${roomId}/battle`), updates);
    actionMode = null;
    aimDir = null;
    // 005의 튕김은 곧바로 들어가지 않고 1초 뒤에 옆 적에게 닿는다.
    // 그동안 그 적 위에 느낌표를 띄워 어디로 튀는지 보여준다.
    if (bounceTo) {
      setTimeout(() => applyLateDamage(bounceTo.key, bounceTo.damage, { bounceMark: null }), BOUNCE_DELAY_MS);
    }
    // 006처럼 자리에 남는 공격: 맞은 칸을 정해진 횟수만큼 계속 태운다.
    if (spec.dot) scheduleDot(targets[0].key, spec.dot);
    attackFlash = { fromKey: from, tiles: line, until: Date.now() + ATTACK_FLASH_MS };
    setTimeout(() => {
      attackFlash = null;
      if (currentRoom && currentRoom.battle) renderBattle(currentRoom);
    }, ATTACK_FLASH_MS);
    startActionCooldown();
  } catch (err) {
    console.error("공격 실패:", err);
    writeFailNotice("공격", err);
  } finally {
    attackInFlight = false;
  }
}

// 맞은 자리에 남는 지속 피해. 정해진 간격마다 그 칸에 서 있는 적을 때린다.
// 그 사이에 적이 자리를 비우면 더 이상 맞지 않는다.
function scheduleDot(key, dot) {
  for (let i = 1; i <= dot.ticks; i++) {
    // 마지막 틱에서 불도 함께 끈다.
    const extra = i === dot.ticks ? { [`burns/${key}`]: null } : null;
    setTimeout(() => applyLateDamage(key, dot.damage, extra), i * dot.everyMs);
  }
}

// 지금 타고 있는 칸들. 불을 끄는 쓰기가 빠지더라도 시간이 지나면 저절로 사라진다.
function burningKeys(battle) {
  const burns = (battle && battle.burns) || {};
  const now = serverNow();
  return Object.keys(burns).filter((key) => {
    const at = burns[key];
    return typeof at === "number" && now - at < BURN_VISIBLE_MS;
  });
}

// 시간이 지난 뒤에 들어가는 피해 (지속 피해 한 틱, 005의 튕김).
// 그 사이 자리를 뜨거나 쓰러졌으면 그냥 지나간다.
async function applyLateDamage(key, damage, extra) {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing") return;

  const opp = battle[oppField()] || {};
  const target = opp[key];
  // 적이 자리를 떴거나 이미 쓰러졌어도, 남겨둔 표시는 지워야 한다.
  if (!target) {
    if (extra) update(ref(db, `rooms/${roomId}/battle`), extra).catch(() => {});
    return;
  }

  const oppRole = isHost ? "guest" : "host";
  const slot = target.slot ?? 0;
  const remaining = Math.max(0, hpOf(battle, oppRole, slot, target.file) - damage);

  const updates = { ...(extra || {}), [`${oppRole}Hp/${slot}`]: remaining };
  if (remaining === 0) updates[`${oppField()}/${key}`] = null;

  try {
    await update(ref(db, `rooms/${roomId}/battle`), updates);
  } catch (err) {
    console.error("나중 피해 실패:", err);
  }
}

// 쌓인 재장전 하나를 탄창으로 옮긴다. 이것도 행위 1회를 쓴다.
async function doReload() {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing" || actionBusy()) return;

  if (!isMyTurn(battle)) {
    pushNotice("상대 차례입니다.", { group: "turn", duration: 1400 });
    return;
  }
  const unit = myUnitAt(battle, activeTile(battle));
  if (!unit) {
    pushNotice("재장전할 유닛을 먼저 고르세요.", { group: "turn", duration: 1600 });
    return;
  }

  const slot = unit.slot ?? 0;
  const ammo = ammoOf(battle, myRole(), slot);
  const pending = pendingOf(battle, myRole(), slot);

  if (ammo >= MAX_AMMO) {
    pushNotice("탄창이 가득 찼습니다.", { group: "reload", duration: 1800 });
    return;
  }
  if (pending <= 0) {
    pushNotice("쌓인 재장전이 없습니다.", { group: "reload", duration: 1800 });
    return;
  }

  const left = Math.max(0, (battle.movesLeft || 0) - 1);
  const handover = turnHandoverUpdates(battle, left);
  const updates = { movesLeft: left, actedAt: serverTimestamp() };
  Object.assign(updates, handover);

  // 차례가 넘어가면서 재장전이 먼저 쌓일 수 있으므로, 그 값을 기준으로 하나를 뺀다.
  const pendingKey = `${myRole()}Pending/${slot}`;
  const basePending = Object.prototype.hasOwnProperty.call(handover, pendingKey)
    ? handover[pendingKey]
    : pending;
  updates[pendingKey] = Math.max(0, basePending - 1);
  updates[`${myRole()}Ammo/${slot}`] = Math.min(MAX_AMMO, ammo + 1);

  reloadInFlight = true;
  playSelect();
  try {
    await update(ref(db, `rooms/${roomId}/battle`), updates);
    actionMode = null;
    aimDir = null;
    startActionCooldown();
  } catch (err) {
    console.error("재장전 실패:", err);
    writeFailNotice("재장전", err);
  } finally {
    reloadInFlight = false;
  }
}

// ---------- 매치 종료 -> 대기실 복귀 ----------
let finishSequenceStarted = false;
function handleFinish(battle) {
  if (battle.phase !== "finished" || finishSequenceStarted) return;
  finishSequenceStarted = true;
  matchFinished = true;

  clearInterval(timerInterval);
  clearInterval(countdownInterval);
  clearInterval(turnInterval);
  countdownOverlay.classList.add("hidden");
  turnBarEl.classList.add("hidden");

  // 방치로 끊긴 경우에는 왜 끝났는지 알려준다.
  const timedOut = battle.endReason === "timeout";
  matchEndTextEl.textContent = timedOut ? "시간 초과" : "매치 종료";
  if (timedOut) {
    pushNotice("20초 동안 아무 행동이 없어 매치를 종료합니다.", { duration: MATCH_END_MS });
  }
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
let playIntroStartedAt = 0;
let playIntroDone = false;

function renderPhaseVisibility(battle) {
  if (battle.phase === "loading") {
    loadingOverlay.classList.remove("hidden");
    battleMain.classList.add("hidden");
    return;
  }

  // 카운트다운이 끝나고 전투가 시작될 때 잠깐 로딩을 보여준 뒤 판을 드러낸다.
  if (battle.phase === "playing" && !playIntroDone) {
    if (!playIntroStartedAt) {
      playIntroStartedAt = Date.now();
      loadingOverlay.querySelector(".loading-text").textContent = "전투 시작...";
      setTimeout(() => {
        if (currentRoom && currentRoom.battle) renderPhaseVisibility(currentRoom.battle);
      }, PLAY_INTRO_MS);
    }
    if (Date.now() - playIntroStartedAt < PLAY_INTRO_MS) {
      loadingOverlay.classList.remove("hidden");
      battleMain.classList.add("hidden");
      return;
    }
    playIntroDone = true;
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

  sidebarBoxEl.classList.toggle("playing", battle.phase === "playing");

  if (battle.phase === "playing") {
    // 내 차례가 끝나면 선택과 이동 준비를 모두 푼다.
    if (!isMyTurn(battle)) {
      activeSlot = null;
      actionMode = null;
      aimDir = null;
    }
    renderTurnSidebar(myPlacements);
    shareSelection(activeTile(battle)); // 상대 화면에 "이 유닛을 움직이는 중"을 보여준다
  } else {
    activeSlot = null;
    actionMode = null;
    aimDir = null;
    prevHp = null;
    renderSidebar(myPlacements);
  }

  renderEnemySidebar(battle, oppPlacements);
  renderMapTiles(myPlacements, oppPlacements);
  if (battle.phase === "playing") showDamage(battle);
  renderMoveHints(battle);
  renderAttackRange(battle);
  renderTimer(battle);
  renderCountdown(battle);
  renderTurnBar(battle);
  maybeAutoPlace(myPlacements);
  maybeAutoComplete(myPlacements);
  if (battle.phase === "playing") passIfStuck(battle);
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

