import "./update-overlay.js";   // 업데이트 중에는 화면을 덮고, 끝나면 재실행 버튼을 띄운다
import { firebaseConfig } from "./firebase-config.js";
import { unitFrameClass, unitNumber } from "./unit-colors.js";
import { maxHp, attackOf, attackOfNumber, damageAt, reloadMs, MAX_ENERGY, ENERGY_PER_SEC, MOVE_COST } from "./unit-stats.js";
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
  getDatabase, ref, set, update, push, onValue, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const AVATAR_PATH = "BS_Plr_Icons/";
const ROWS = 15;
const COLS = 15;

// 벽. 이동도 공격도 막는다. 판 좌표 기준 [행, 열]이며,
// 양쪽이 같은 조건이 되도록 위아래·좌우 대칭으로 둔다 (위쪽 절반만 적고 아래는 뒤집어 만든다).
const WALLS_TOP_HALF = [
  [2, 2], [2, 3], [2, 11], [2, 12],   // 스폰 양옆의 짧은 벽
  [3, 6], [3, 7], [3, 8],             // 스폰 바로 앞 엄폐물
  [5, 0], [5, 1], [5, 13], [5, 14],   // 가장자리 벽
  [5, 4], [6, 4], [5, 10], [6, 10],   // 안쪽 세로 벽
  [7, 2], [7, 3], [7, 11], [7, 12],   // 가운데 줄 양쪽
  [7, 7]                              // 한가운데 기둥
];
const WALLS = new Set();
WALLS_TOP_HALF.forEach(([r, c]) => {
  [[r, c], [ROWS - 1 - r, c]].forEach(([wr, wc]) => {
    WALLS.add(`${wr}_${wc}`);
    WALLS.add(`${wr}_${COLS - 1 - wc}`);
  });
});
function isWall(key) {
  return WALLS.has(key);
}

// 유닛이 나오는 칸. 방장은 맨 아래 줄, 손님은 맨 위 줄 가운데.
// (손님 화면은 세로로 뒤집혀 있어서, 둘 다 자기 스폰이 화면 맨 아래에 보인다)
const SPAWN = { host: `${ROWS - 1}_${Math.floor(COLS / 2)}`, guest: `0_${Math.floor(COLS / 2)}` };
const RESPAWN_DELAY_MS = 1000;  // 유닛이 쓰러진 뒤 다음 유닛이 나오기까지
const MAX_AMMO = 3;            // 유닛마다 가지는 탄창 수
// 한 칸 움직인 뒤 이만큼은 다음 이동을 받지 않는다.
// 연속으로 밀어 넣으면 서버에 반영되기 전 상태로 다음 이동을 계산하게 되어 어긋날 수 있다.
const ACTION_GUARD_MS = 250;    // 연타로 같은 행동이 두 번 나가지 않게 하는 최소 간격
                                // (진짜 제동은 에너지가 건다)
const BOUNCE_DELAY_MS = 1500;   // 005의 튕김이 옆 적에게 닿기까지 (느낌표가 떠 있는 시간이기도 하다)
const BURN_VISIBLE_MS = 3400;   // 006이 붙인 불이 남아 있는 시간

const TURN_IDLE_MS = 20000;    // 이 시간 동안 아무 것도 안 하면 매치가 끊긴다
// 개발 중에는 방치 감지를 꺼둔다. 상대가 이동을 마칠 때까지 그냥 기다린다.
// 다시 켜려면 이 값만 true로 바꾸면 된다.
const IDLE_TIMEOUT_ENABLED = false;
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

const loadingStartedAt = Date.now();

let countdownInterval = null;
let turnInterval = null;
// 지금 판에 나와 있는 내 유닛의 번호(0,1,2). 한 번에 한 마리만 나온다.
let activeSlot = null;
let aimDir = null;         // 공격 조준 방향 (방향키로 정하고 스페이스로 쏜다)
let matchFinished = false; // 정상 종료로 대기실에 돌아가는 중인지 (상대 이탈과 구분)

const loadingOverlay = document.getElementById("loading-overlay");
const battleMain = document.getElementById("battle-main");
const sidebarEl = document.getElementById("unit-slots");
const sidebarBoxEl = document.getElementById("unit-sidebar");
const countdownOverlay = document.getElementById("countdown-overlay");
const countdownNumberEl = document.getElementById("countdown-number");
const enemySidebarEl = document.getElementById("enemy-sidebar");
const enemySlotsEl = document.getElementById("enemy-slots");
const myEnergyEl = document.getElementById("my-energy");
const enemyEnergyEl = document.getElementById("enemy-energy");
const mapEl = document.getElementById("battle-map");
const mapViewportEl = document.getElementById("map-viewport");
const matchEndOverlay = document.getElementById("match-end-overlay");
const matchEndTextEl = matchEndOverlay.querySelector(".match-end-text");
const turnBarEl = document.getElementById("turn-bar");
const turnActionsEl = document.getElementById("turn-actions");
const actMoveBtn = document.getElementById("act-move");
const actAttackBtn = document.getElementById("act-attack");
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
// 판 좌표의 행이 화면에서 몇 번째 줄인지 (게스트 화면은 세로로 뒤집혀 있다)
function displayRow(r) {
  return isHost ? r : ROWS - 1 - r;
}

// 대기실에서 장착한 유닛 셋. 방 데이터에는 배열이나 번호를 키로 한 객체로 들어 있어 [0,1,2]로 맞춘다.
function unitsOf(role) {
  const raw = (currentRoom && currentRoom[`${role}Units`]) || {};
  return [0, 1, 2].map((slot) => raw[slot] || null);
}

// ---------- 맵 생성 ----------
function buildMap() {
  mapEl.innerHTML = "";
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const key = `${r}_${c}`;
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = r;
      tile.dataset.col = c;

      if (isWall(key)) tile.classList.add("wall");
      if (key === SPAWN[myRole()]) tile.classList.add("spawn-mine");
      if (key === SPAWN[isHost ? "guest" : "host"]) tile.classList.add("spawn-foe");

      // 게스트는 자신의 스폰이 항상 화면 아래쪽에 오도록 세로로만 뒤집어서 배치한다 (좌우는 그대로).
      tile.style.gridRowStart = displayRow(r) + 1;
      tile.style.gridColumnStart = c + 1;

      mapEl.appendChild(tile);
    }
  }
}

// ---------- 카메라 ----------
// 판이 화면보다 커서 일부만 보인다. 칸 크기는 그대로 두고 판을 옮겨,
// 내 유닛이 가운데 오게 한다 (판 끝에서는 더 밀지 않는다). 유닛이 나오기 전에는 내 스폰을 본다.
let cameraPlaced = false;
function updateCamera(battle) {
  const vw = mapViewportEl.clientWidth;
  const vh = mapViewportEl.clientHeight;
  if (!vw || !vh) return; // 아직 화면에 안 보이는 중

  const focusKey = activeTile(battle) || SPAWN[myRole()];
  const { r, c } = parseTile(focusKey);
  const tile = mapEl.querySelector(`.tile[data-row="${r}"][data-col="${c}"]`);
  if (!tile) return;

  const maxX = Math.max(0, mapEl.offsetWidth - vw);
  const maxY = Math.max(0, mapEl.offsetHeight - vh);
  const x = Math.max(0, Math.min(maxX, tile.offsetLeft + tile.offsetWidth / 2 - vw / 2));
  const y = Math.max(0, Math.min(maxY, tile.offsetTop + tile.offsetHeight / 2 - vh / 2));

  // 처음 자리 잡을 때는 미끄러지지 않고 바로 그 자리에서 시작한다.
  mapEl.classList.toggle("camera-instant", !cameraPlaced);
  mapEl.style.transform = `translate(${-x}px, ${-y}px)`;
  if (!cameraPlaced) {
    void mapEl.offsetWidth;
    mapEl.classList.remove("camera-instant");
    cameraPlaced = true;
  }
}
window.addEventListener("resize", () => {
  cameraPlaced = false;
  if (currentRoom && currentRoom.battle) updateCamera(currentRoom.battle);
});

// ---------- 스폰 ----------
// 유닛은 대기실에서 장착한 순서(1번 칸부터)대로 한 마리씩 나온다.
// 판에 내 유닛이 없고 아직 쓰러지지 않은 유닛이 남아 있으면, 그중 첫 번째를 내 스폰에 내보낸다.
// 각자 자기 유닛만 내보낸다 (규칙상 남의 유닛 칸은 쓸 수 없다).
function nextSlot(battle) {
  const units = unitsOf(myRole());
  return [0, 1, 2].find((slot) => units[slot] && hpOf(battle, myRole(), slot, units[slot]) > 0) ?? null;
}

// 스폰 칸에 누가 서 있으면 가장 가까운 빈칸에 내보낸다.
function spawnTile(battle) {
  const origin = parseTile(SPAWN[myRole()]);
  let best = null;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const key = tileKey(r, c);
      if (isWall(key) || occupant(battle, key)) continue;
      const d = Math.abs(r - origin.r) + Math.abs(c - origin.c);
      if (!best || d < best.d) best = { key, d };
    }
  }
  return best && best.key;
}

let spawnTimer = null;
let spawnInFlight = false;
function maybeSpawn(battle) {
  if (battle.phase !== "countdown" && battle.phase !== "playing") return;
  if (spawnTimer || spawnInFlight) return;
  if (Object.keys(battle[battleField()] || {}).length > 0) return;
  if (nextSlot(battle) === null) return;

  // 첫 유닛은 바로, 쓰러진 뒤의 다음 유닛은 잠깐 쉬었다가 나온다.
  const units = unitsOf(myRole());
  const anyDown = [0, 1, 2].some((slot) => units[slot] && hpOf(battle, myRole(), slot, units[slot]) <= 0);

  spawnTimer = setTimeout(async () => {
    spawnTimer = null;
    const now = currentRoom && currentRoom.battle;
    if (!now || (now.phase !== "countdown" && now.phase !== "playing")) return;
    if (Object.keys(now[battleField()] || {}).length > 0) return;
    const slot = nextSlot(now);
    const key = spawnTile(now);
    if (slot === null || !key) return;

    spawnInFlight = true;
    try {
      await update(ref(db, `rooms/${roomId}/battle/${battleField()}`), {
        [key]: { slot, file: unitsOf(myRole())[slot] }
      });
      playSelect();
    } catch (err) {
      console.error("유닛 등장 실패:", err);
      writeFailNotice("유닛을 내보내", err);
      await wait(2000);
    } finally {
      spawnInFlight = false;
      if (currentRoom && currentRoom.battle) maybeSpawn(currentRoom.battle);
    }
  }, anyDown ? RESPAWN_DELAY_MS : 0);
}

// ---------- 맵 타일 렌더링 ----------
function renderMapTiles(myPlacements, oppPlacements) {
  const battle = (currentRoom && currentRoom.battle) || {};
  mapEl.classList.add("playing");

  const selected = activeTile(battle);
  const burning = burningTiles(battle);

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

    // 불도 자리에 남는다. 그 칸에 선 유닛이 틱마다 타고, 자리를 비우면 더 맞지 않는다.
    if (Object.prototype.hasOwnProperty.call(burning, key)) {
      const fire = document.createElement("div");
      // 내가 붙인 불은 푸르게, 내가 맞고 있는 불은 더 붉게 보인다.
      fire.className = "burn-fx " + (burning[key] ? "mine" : "foe");
      fire.innerHTML = `<i class="mat"></i>` +
        ["c", "l", "r", "t", "b"].map((pos) => `<i class="spark s-${pos}"></i>`).join("");
      tile.appendChild(fire);
    }

    // 튕김 예고는 유닛이 아니라 그 칸에 남는다. 피해도 1초 뒤 그 칸에 선 유닛이 받으므로,
    // 나중에 실시간으로 바꾸면 그 사이 칸에서 벗어나 피할 수 있다.
    // 표시는 방 데이터에 있으므로 쏜 쪽과 맞는 쪽 모두에게 같이 보인다.
    if (key === bounceMarkKey(battle)) {
      const warn = document.createElement("div");
      warn.className = "bounce-warn";
      warn.textContent = "!";
      tile.appendChild(warn);
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

  // 유닛을 고르면 WASD로 갈 수 있는 방향을 보여준다.
  if (!battle || battle.phase !== "playing") return;
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

// 산탄은 가로 폭이 줄마다 달라서, 앞으로 몇 칸째인지마다 네모를 따로 그린다 (계단 모양 부채꼴).
// 한 줄로 나가는 공격은 자기 칸부터 끝까지 네모 하나.
function rangeBoxes(fromKey, tiles, spread) {
  if (!tiles.length) return [];
  if (!spread) return [rangeBox(fromKey, tiles, true)];
  const byDistance = {};
  tiles.forEach((t) => { (byDistance[t.distance] = byDistance[t.distance] || []).push(t); });
  return Object.values(byDistance).map((row) => rangeBox(row[0].key, row.slice(1), true));
}

function renderAttackRange(battle) {
  mapEl.querySelectorAll(".range-box").forEach((el) => el.remove());
  if (!battle || battle.phase !== "playing") return;

  // 화살표로 조준한 방향의 사거리를 보여준다. 쏘는 순간 조준이 풀리므로 바로 사라진다.
  // 벽이나 유닛이 있어도 사거리 전체를 보여준다.
  if (!aimDir) return;

  const from = activeTile(battle);
  const unit = myUnitAt(battle, from);
  const spec = attackOf(unit && unit.file);
  if (!unit || !spec) return;

  const tiles = attackTiles(from, aimDir, unit.file);
  rangeBoxes(from, tiles, !!spec.spread).forEach((box) => mapEl.appendChild(box));
}

// ---------- 카운트다운 ----------
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

// ---------- 실시간 진행 ----------
// 차례가 없다. 유닛마다 에너지가 초당 10씩 100까지 차오르고, 그 에너지로 행동한다.
// 방 데이터에는 "언제 얼마였는지"만 적어두고(v, at), 지금 값은 양쪽이 각자 시간으로 셈한다.
// 그래서 에너지가 차는 동안에는 아무 것도 주고받지 않는다.
const myRole = () => (isHost ? "host" : "guest");

function energyOf(battle, role) {
  const cell = battle && battle[`${role}Energy`];
  if (!cell || typeof cell.v !== "number") return MAX_ENERGY;
  const at = typeof cell.at === "number" ? cell.at : 0;
  if (!at || !serverTimeReady()) return Math.min(MAX_ENERGY, Math.max(0, cell.v));
  const grown = cell.v + ((serverNow() - at) / 1000) * ENERGY_PER_SEC;
  return Math.max(0, Math.min(MAX_ENERGY, grown));
}

// 행동에 쓴 만큼 깎고, 거기서부터 다시 차오르게 새 기준점을 적는다.
// 에너지는 세 유닛이 함께 쓰는 하나뿐인 값이라, 어느 유닛이 써도 같은 곳에서 빠진다.
function spendEnergy(battle, cost) {
  const left = Math.max(0, energyOf(battle, myRole()) - cost);
  return { [`${myRole()}Energy`]: { v: Math.round(left), at: serverTimestamp() } };
}

// 에너지가 모자라면 알리고 막는다.
// 에너지는 이동에만 쓴다.
function canAffordMove(battle) {
  const have = energyOf(battle, myRole());
  if (have + 0.5 >= MOVE_COST) return true;
  pushNotice(`에너지가 모자랍니다.
이동 ${MOVE_COST} (지금 ${Math.floor(have)})`,
    { group: "energy", duration: 1600 });
  return false;
}

// 카운트다운이 끝나면 방장이 대표로 첫 턴을 연다.
let playStartRequested = false;
async function startPlaying() {
  if (playStartRequested) return;
  playStartRequested = true;
  try {
    // 캐릭터마다 기본 체력이 다르므로, 대기실에서 장착한 유닛 셋을 보고 채운다.
    // (아직 나오지 않은 유닛도 체력을 적어둬야 "쓰러짐"과 "대기 중"을 구분할 수 있다)
    const fullHp = (role) => {
      const table = {};
      unitsOf(role).forEach((file, slot) => {
        if (file) table[slot] = maxHp(file);
      });
      return table;
    };
    // 양쪽 모두 에너지가 가득 찬 채로 시작한다.
    const fullEnergy = () => ({ v: MAX_ENERGY, at: serverTimestamp() });
    const fullAmmo = () => {
      const table = {};
      for (let slot = 0; slot < 3; slot++) table[slot] = { v: MAX_AMMO, at: serverTimestamp() };
      return table;
    };
    await update(ref(db, `rooms/${roomId}/battle`), {
      phase: "playing",
      startedAt: serverTimestamp(),
      actedAt: serverTimestamp(),
      hostHp: fullHp("host"),
      guestHp: fullHp("guest"),
      hostAmmo: fullAmmo(),
      guestAmmo: fullAmmo(),
      hostEnergy: fullEnergy(),
      guestEnergy: fullEnergy()
    });
  } catch (err) {
    console.error("전투 시작 실패:", err);
    playStartRequested = false;
  }
}

// 지금 판에 나와 있는 내 유닛이 서 있는 칸. 한 번에 한 마리뿐이다.
function activeTile(battle) {
  if (!battle) return null;
  const mine = battle[battleField()] || {};
  return Object.keys(mine).find((k) => mine[k]) || null;
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

// 그 방향으로 한 칸 갈 수 있는지 본다. 판 밖이거나 벽이거나 누가 서 있으면 못 간다.
function stepTarget(battle, fromKey, dir) {
  const [dr, dc] = dir;
  const { r, c } = parseTile(fromKey);
  const nr = r + dr;
  const nc = c + dc;
  if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return null;
  const key = tileKey(nr, nc);
  if (isWall(key) || occupant(battle, key)) return null;
  return key;
}

// 한 칸 이동. 에너지를 그만큼 쓰고, 쓴 자리에서 다시 차오른다.
let moveInFlight = false;
let attackInFlight = false;
// 이 시각 전에는 다음 행동(이동/공격)을 받지 않는다.
// 경과 시간만 보므로 PC 시계가 어긋나 있어도 정확하다.
let actionReadyAt = 0;

function onActionCooldown() {
  return Date.now() < actionReadyAt;
}

// 쓰기가 오가는 중이면 새 행동을 받지 않는다 (연타로 같은 행동이 두 번 나가는 것을 막는다).
function actionBusy() {
  return moveInFlight || attackInFlight || onActionCooldown();
}

// 한 번 행동한 뒤 잠시 쉬고, 쉬는 시간이 끝나면 화면을 다시 그려 표시를 되살린다.
function startActionCooldown() {
  actionReadyAt = Date.now() + ACTION_GUARD_MS;
  setTimeout(() => {
    if (currentRoom && currentRoom.battle) renderBattle(currentRoom);
  }, ACTION_GUARD_MS);
}

async function moveUnit(fromKey, dir) {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing" || actionBusy()) return;

  const mine = battle[battleField()] || {};
  const unit = mine[fromKey];
  if (!unit) return;

  const toKey = stepTarget(battle, fromKey, dir);
  if (!toKey) {
    // 판 밖이거나 벽이거나 그 방향에 누가 서 있다
    pushNotice("실패: 해당 방향으로\n이동할 수 없습니다.", { group: "move", duration: 1800 });
    return;
  }

  if (!canAffordMove(battle)) return;

  const field = battleField();
  const updates = {
    [`${field}/${fromKey}`]: null,
    [`${field}/${toKey}`]: { slot: unit.slot, file: unit.file },
    actedAt: serverTimestamp(),
    ...spendEnergy(battle, MOVE_COST)
  };

  // 조준 방향은 그대로 두어, 움직인 자리에서 바로 스페이스로 쏠 수 있다.
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

// 한쪽 유닛 셋이 모두 쓰러지면 매치가 끝난다. 먼저 알아챈 쪽이 적어둔다.
// 유닛이 쓰러지고 다음 유닛이 나오기 전에는 판이 잠깐 비므로, 판이 아니라 체력으로 센다.
function aliveCount(battle, role) {
  const units = unitsOf(role);
  return [0, 1, 2].filter((slot) => units[slot] && hpOf(battle, role, slot, units[slot]) > 0).length;
}

let wipeEndRequested = false;
function checkWipe(battle) {
  if (wipeEndRequested || !battle || battle.phase !== "playing" || !battle.startedAt) return;
  const hostLeft = aliveCount(battle, "host");
  const guestLeft = aliveCount(battle, "guest");
  if (hostLeft > 0 && guestLeft > 0) return;

  wipeEndRequested = true;
  update(ref(db, `rooms/${roomId}/battle`), {
    phase: "finished",
    endReason: "wipe",
    winner: hostLeft > 0 ? "host" : guestLeft > 0 ? "guest" : "none",
    finishedAt: serverTimestamp()
  }).catch((err) => {
    console.error("매치 종료 처리 실패:", err);
    wipeEndRequested = false;
  });
}

// 방치 감지. 한동안 양쪽 모두 아무 것도 하지 않으면 매치를 끝낸다 (지금은 꺼둠).
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

// WASD는 화면 기준 네 방향 이동. 한글 입력 상태에서도 같은 자리의 키가 먹도록 e.code로 본다.
const MOVE_KEYS = { KeyW: "ArrowUp", KeyA: "ArrowLeft", KeyS: "ArrowDown", KeyD: "ArrowRight" };

// 전투 조작: 판에 나와 있는 내 유닛을 WASD 이동, 화살표 조준, 스페이스 공격.
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing") return;

  const moveKey = MOVE_KEYS[e.code];
  const aimKey = DIRECTIONS[e.key] ? e.key : null;
  const isSpace = e.code === "Space";
  if (!moveKey && !aimKey && !isSpace) return;
  // 화면 스크롤, 그리고 포커스된 버튼이 스페이스로 눌리는 것을 막는다.
  e.preventDefault();
  if (e.repeat) return; // 누르고 있어도 한 번만

  const from = activeTile(battle);
  if (!from) {
    pushNotice("다음 유닛이 나오는 중입니다.", { group: "turn", duration: 1200 });
    return;
  }

  if (isSpace) fireAttack();
  else if (aimKey) aimAt(aimKey);
  else moveUnit(from, screenDirection(moveKey));
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
// 탄창도 에너지와 같은 방식이다. "언제 몇 발이었는지"만 적어두고,
// 지금 몇 발인지는 유닛별 장전 시간으로 각자 셈한다.
// 그래서 차오르는 동안에는 주고받는 것이 없다.
function ammoState(battle, role, slot, file) {
  const cell = (battle[`${role}Ammo`] || {})[slot];
  const per = reloadMs(file);
  if (!cell || typeof cell.v !== "number") return { ammo: MAX_AMMO, progress: 0 };

  const base = Math.max(0, Math.min(MAX_AMMO, cell.v));
  const at = typeof cell.at === "number" ? cell.at : 0;
  if (!at || !serverTimeReady() || base >= MAX_AMMO) return { ammo: base, progress: 0 };

  const elapsed = Math.max(0, serverNow() - at);
  const gained = Math.floor(elapsed / per);
  const ammo = Math.min(MAX_AMMO, base + gained);
  // 다음 한 발이 얼마나 찼는지 (막대에 조금씩 차오르는 모습으로 보여준다)
  const progress = ammo >= MAX_AMMO ? 0 : (elapsed % per) / per;
  return { ammo, progress };
}

function ammoOf(battle, role, slot, file) {
  return ammoState(battle, role, slot, file).ammo;
}

// 한 발 쓰고 남은 값을 적는다. 이미 차오르던 중이었다면 그 진행은 살려 둔다.
function spendAmmo(battle, slot, file) {
  const per = reloadMs(file);
  const cell = (battle[`${myRole()}Ammo`] || {})[slot];
  const base = cell && typeof cell.v === "number" ? Math.max(0, Math.min(MAX_AMMO, cell.v)) : MAX_AMMO;
  const at = cell && typeof cell.at === "number" ? cell.at : 0;

  if (!at || !serverTimeReady() || base >= MAX_AMMO) {
    // 가득 찬 상태에서 쏘면 지금부터 다음 한 발이 차기 시작한다.
    return { [`${myRole()}Ammo/${slot}`]: { v: Math.max(0, Math.min(MAX_AMMO, base) - 1), at: serverTimestamp() } };
  }

  const elapsed = Math.max(0, serverNow() - at);
  const gained = Math.floor(elapsed / per);
  const now = ammoState(battle, myRole(), slot, file).ammo;
  if (now >= MAX_AMMO) {
    return { [`${myRole()}Ammo/${slot}`]: { v: MAX_AMMO - 1, at: serverTimestamp() } };
  }
  // 채워진 만큼만 기준점을 밀어, 남은 진행(예: 2.6초째)은 그대로 이어간다.
  return {
    [`${myRole()}Ammo/${slot}`]: {
      v: Math.max(0, now - 1),
      at: at + gained * per
    }
  };
}

// 남은 탄창을 점으로 보여준다. 차오르는 중인 한 발은 조금씩 채워진다.
function ammoRowHtml(role, slot, file) {
  let pips = "";
  for (let i = 0; i < MAX_AMMO; i++) pips += `<i><b></b></i>`;
  return `<div class="ammo-row" data-role="${role}" data-slot="${slot}" data-file="${file}">${pips}</div>`;
}

// 탄창 점을 지금 값에 맞춰 칠한다 (카드를 다시 만들지 않는다).
// 대기 중인 유닛도 탄창을 보여준다 (나오면 그 상태로 시작한다).
function paintAmmo(battle) {
  document.querySelectorAll(".ammo-row").forEach((row) => {
    const role = row.dataset.role;
    const slot = Number(row.dataset.slot);
    const file = row.dataset.file;
    if (!file) return;

    const { ammo, progress } = ammoState(battle, role, slot, file);
    row.querySelectorAll("i").forEach((pip, i) => {
      const loaded = i < ammo;
      pip.classList.toggle("loaded", loaded);
      // 다음 한 발이 들어올 자리는 채워지는 만큼만 칠한다.
      const filling = !loaded && i === ammo;
      pip.classList.toggle("filling", filling);
      // 채워지는 칸만 길이를 갖는다. 다 찬 칸은 0으로 되돌려, 거꾸로 줄어드는 모습이 보이지 않게 한다.
      pip.querySelector("b").style.width = filling ? `${(progress * 100).toFixed(1)}%` : "0%";
    });
  });
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
// 유닛 셋을 나오는 순서대로 보여준다. 판에 나와 있는 유닛은 강조, 쓰러진 유닛은 흐리게.
function rosterCard(battle, role, slot, file, withAmmo) {
  const out = activeSlotOf(battle, role) === slot;
  const hp = hpOf(battle, role, slot, file);
  const card = document.createElement("div");
  card.className = "unit-slot-card with-hp"
    + (out ? " selected" : "")
    + (hp <= 0 ? " down" : "");
  card.innerHTML = `
    <span class="key-badge">${slot + 1}</span>
    ${hpBarHtml(hp, file, prevHp && prevHp[role][slot])}
    <div class="unit-tile ${unitFrameClass(file)}">
      <img src="${AVATAR_PATH}${file}" alt="">
    </div>
    ${withAmmo ? ammoRowHtml(role, slot, file) : ""}
  `;
  return card;
}

function activeSlotOf(battle, role) {
  const placements = battle[`${role}Placements`] || {};
  const unit = Object.values(placements).find(Boolean);
  return unit ? (unit.slot ?? 0) : null;
}

function renderTurnSidebar() {
  const battle = currentRoom.battle;
  sidebarEl.innerHTML = "";

  unitsOf(myRole()).forEach((file, slot) => {
    if (file) sidebarEl.appendChild(rosterCard(battle, myRole(), slot, file, true));
  });

  animateHpBars(sidebarEl);

  const canAct = activeSlot !== null && battle.phase === "playing";
  turnActionsEl.classList.toggle("hidden", !canAct);
  actAttackBtn.classList.toggle("on", !!aimDir);

  // 판 아래 안내에는 키를 보여준다. 에너지는 이동에만 들어서 이동 쪽에만 적는다.
  actMoveBtn.textContent = `이동 WASD ${MOVE_COST}`;
  actAttackBtn.textContent = "조준 ←↑↓→ · 공격 Space";
  paintActionGuide(battle);
}

// 지금 에너지·탄창으로 할 수 없는 행동은 흐리게 보여준다.
function paintActionGuide(battle) {
  const unit = myUnitAt(battle, activeTile(battle));
  if (!unit) return;
  actMoveBtn.classList.toggle("off", energyOf(battle, myRole()) + 0.5 < MOVE_COST);
  actAttackBtn.classList.toggle("off", !canAttackNow(battle));
}

// 에너지 원형 게이지. 한 번 만들어 둔 것을 계속 쓰고, 여기서는 채워진 길이와
// 숫자만 고친다 (다시 그리지 않으므로 행동할 때 깜빡이지 않는다).
const RING_LENGTH = 2 * Math.PI * 41;   // svg 원 둘레
function paintRing(box, value) {
  if (!box) return;
  const fill = box.querySelector(".ring-fill");
  const ratio = Math.max(0, Math.min(1, value / MAX_ENERGY));
  fill.style.strokeDasharray = RING_LENGTH;
  fill.style.strokeDashoffset = RING_LENGTH * (1 - ratio);
  box.querySelector(".ring-value").textContent = Math.floor(value);
  box.classList.toggle("full", value >= MAX_ENERGY - 0.5);
}

// 200ms마다 게이지 값만 손본다.
// 게이지는 화면이 그려지는 박자마다 손본다. 0.2초마다 툭툭 늘리면 계단처럼 보여서,
// 매 프레임 시간을 다시 읽어 그 순간의 값으로 그린다 (통신은 하지 않는다).
let paintFrame = null;
function startPaintLoop() {
  if (paintFrame !== null) return;
  const step = () => {
    const battle = currentRoom && currentRoom.battle;
    if (!battle || battle.phase !== "playing") { paintFrame = null; return; }
    paintRing(myEnergyEl, energyOf(battle, myRole()));
    paintRing(enemyEnergyEl, energyOf(battle, isHost ? "guest" : "host"));
    paintAmmo(battle);
    paintFrame = requestAnimationFrame(step);
  };
  paintFrame = requestAnimationFrame(step);
}

function tickEnergy() {
  const battle = currentRoom && currentRoom.battle;
  if (!battle || battle.phase !== "playing") return;

  startPaintLoop();

  // 에너지가 차면서 할 수 있게 된 행동을 다시 밝힌다.
  paintActionGuide(battle);
}

// 오른쪽 사이드바: 상대 유닛의 상태만 보여준다 (고를 수 없고 단축키도 없다).
// 상대도 유닛 셋을 나오는 순서대로 보여준다 (탄창은 감춘다).
function renderEnemySidebar(battle) {
  const oppRole = isHost ? "guest" : "host";
  enemySlotsEl.innerHTML = "";

  unitsOf(oppRole).forEach((file, slot) => {
    if (file) enemySlotsEl.appendChild(rosterCard(battle, oppRole, slot, file, false));
  });

  animateHpBars(enemySlotsEl);
}

// 위쪽 띠: 이제 플레이 시간만 보여준다 (00:00). 같은 타이머로 게이지도 함께 그린다.
function renderTurnBar(battle) {
  clearInterval(turnInterval);

  if (!battle || battle.phase !== "playing") {
    turnBarEl.classList.add("hidden");
    return;
  }
  turnBarEl.classList.remove("hidden");

  const tick = () => {
    let sec = 0;
    if (serverTimeReady() && battle.startedAt) {
      sec = Math.max(0, Math.floor((serverNow() - battle.startedAt) / 1000));
    }
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    turnBarEl.textContent = `${mm}:${ss}`;
    tickEnergy();
  };
  tick();
  turnInterval = setInterval(tick, 200);
}

// ---------- 공격 ----------
// 조준한 방향의 사거리 칸 전체 (판 밖은 빼고, 자기 칸은 포함하지 않는다).
// 벽이나 유닛이 있어도 끊지 않는다. 실제로 어디까지 맞는지는 공격마다 따로 본다.
// 산탄은 줄마다 가로로 퍼진 칸들이고, 같은 줄 안에서는 한쪽 끝부터 순서대로 담긴다.
function attackTiles(fromKey, dirKey, file) {
  const spec = attackOf(file);
  const dir = screenDirection(dirKey);
  if (!spec || !dir || !fromKey) return [];

  if (spec.spread) {
    return spreadCells(fromKey, dir, spec.spread)
      .sort((a, b) => a.d - b.d || a.side - b.side)
      .map((cell) => ({ key: cell.key, distance: cell.d }));
  }

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

// 한 줄 공격이 실제로 닿는 칸: 벽을 만나면 거기서 끊긴다.
function untilWall(tiles) {
  const out = [];
  for (const t of tiles) {
    if (isWall(t.key)) break;
    out.push(t);
  }
  return out;
}

// ---------- 산탄 (Shelly) ----------
// dir 은 판 좌표 기준 방향. 옆 방향은 앞 방향을 90도 돌린 것이다.
// 총알마다 도착 칸을 구하고, 판 밖으로 나가는 총알은 뺀다.
// 총구(바로 앞 가운데 칸)도 함께 돌려준다 (d: 1, side: 0, muzzle: true).
function spreadCells(fromKey, dir, spread) {
  const { r, c } = parseTile(fromKey);
  const side = [dir[1], dir[0]];
  const cell = (d, sd) => ({ r: r + dir[0] * d + side[0] * sd, c: c + dir[1] * d + side[1] * sd });
  const onBoard = (p) => p.r >= 0 && p.r < ROWS && p.c >= 0 && p.c < COLS;

  const out = [];
  const muzzle = cell(1, 0);
  if (onBoard(muzzle)) out.push({ key: tileKey(muzzle.r, muzzle.c), d: 1, side: 0, muzzle: true, damage: 0 });
  spread.bullets.forEach((b) => {
    const p = cell(b.d, b.side);
    if (onBoard(p)) out.push({ key: tileKey(p.r, p.c), d: b.d, side: b.side, damage: b.damage });
  });
  return out;
}

const DIR_NAME = { "-1,0": "n", "1,0": "s", "0,-1": "w", "0,1": "e" };
const DIR_VEC = { n: [-1, 0], s: [1, 0], w: [0, -1], e: [0, 1] };

// 맞은 칸별 피해를 모아 체력 쓰기로 바꾼다. 체력이 0이 된 유닛은 판에서 내린다.
function hitUpdates(battle, hits) {
  const opp = battle[oppField()] || {};
  const oppRole = isHost ? "guest" : "host";
  const updates = {};
  Object.keys(hits).forEach((key) => {
    const target = opp[key];
    if (!target || hits[key] <= 0) return;
    const slot = target.slot ?? 0;
    const remaining = Math.max(0, hpOf(battle, oppRole, slot, target.file) - hits[key]);
    updates[`${oppRole}Hp/${slot}`] = remaining;
    if (remaining === 0) updates[`${oppField()}/${key}`] = null;
  });
  return updates;
}

// 쏜 쪽이 총알 도착 시각에 맞춰 판정한다. 그 순간 그 칸에 서 있는 적만 맞는다.
// 단발이라 먼저 한 발이 바로 앞 칸(총구)까지 간다.
//  1칸째 도착: 총구가 벽이면 막힌다. 총구에 적이 있으면 퍼지지 않고 그 적만 전부 맞는다 (3000).
//  2칸째 도착: 총구가 비어 있었다면 갈라진 총알이 앞의 칸들에 떨어져, 그 칸들의 적이 한 발씩 맞는다
//              (도착 칸이 벽이면 그 총알은 막힌다).
function resolveSpread(fromKey, dir, spread, shotId, elapsedMs) {
  const cells = spreadCells(fromKey, dir, spread);
  const muzzle = cells.find((cell) => cell.muzzle);
  const total = spread.bullets.reduce((sum, b) => sum + b.damage, 0);
  const shotPath = { [`shots/${shotId}`]: null };
  let ended = false;

  const write = (updates) => update(ref(db, `rooms/${roomId}/battle`), updates)
    .catch((err) => console.error("총알 판정 실패:", err));
  const live = () => {
    const battle = currentRoom && currentRoom.battle;
    return battle && battle.phase === "playing" ? battle : null;
  };
  const landed = (battle, distance) => {
    const opp = battle[oppField()] || {};
    const hits = {};
    cells.filter((cell) => cell.d === distance && !cell.muzzle && !isWall(cell.key) && opp[cell.key])
      .forEach((cell) => { hits[cell.key] = (hits[cell.key] || 0) + cell.damage; });
    return hitUpdates(battle, hits);
  };

  setTimeout(() => {
    const battle = live();
    if (!battle) { ended = true; return; }
    const opp = battle[oppField()] || {};

    if (!muzzle || isWall(muzzle.key)) {
      ended = true;
      write(shotPath);
      return;
    }
    if (opp[muzzle.key]) {
      ended = true;
      write({ ...hitUpdates(battle, { [muzzle.key]: total }), ...shotPath });
      return;
    }
    const updates = landed(battle, 1);
    if (Object.keys(updates).length) write(updates);
  }, Math.max(0, spread.tileMs - elapsedMs));

  setTimeout(() => {
    if (ended) return;
    const battle = live();
    if (!battle) return;
    write({ ...landed(battle, 2), ...shotPath });
  }, Math.max(0, spread.tileMs * 2 - elapsedMs));
}

// 구슬 총알 그리기. 발사 기록을 보고 양쪽 화면이 같은 시각에 맞춰 그린다.
// 날아가는 동안에는 주고받는 것이 없다. 그림은 각자 자기 화면의 판을 보고 총구에서 막힐지 정한다.
const shownShots = new Set();
function renderShots(battle) {
  const shots = battle.shots || {};
  Object.keys(shots).forEach((id) => {
    if (shownShots.has(id)) return;
    const shot = shots[id];
    const spec = shot && attackOfNumber(shot.unit);
    const dir = shot && DIR_VEC[shot.dir];
    if (!spec || !spec.spread || !dir || !shot.from) { shownShots.add(id); return; }

    const age = serverTimeReady() && typeof shot.at === "number" ? Math.max(0, serverNow() - shot.at) : 0;
    if (age >= spec.spread.tileMs * 2) { shownShots.add(id); return; }
    if (!mapViewportEl.clientWidth) return; // 판이 아직 가려져 있으면 다음에 그린다

    shownShots.add(id);
    animateSpread(shot, dir, spec.spread, age);
  });
}

function tileCenter(key) {
  const { r, c } = parseTile(key);
  const tile = mapEl.querySelector(`.tile[data-row="${r}"][data-col="${c}"]`);
  if (!tile) return null;
  return {
    x: tile.offsetLeft + tile.offsetWidth / 2,
    y: tile.offsetTop + tile.offsetHeight / 2,
    half: tile.offsetWidth / 2
  };
}

// p0 에서 벽 칸 한가운데(wall)로 가는 선이 벽 칸 가장자리에 처음 닿는 곳.
// 총알 반지름만큼 앞에서 멈춰야 총알 가장자리가 벽에 딱 붙는다.
// t 는 선 위의 비율(0~1), normal 은 벽이 총알 쪽으로 향한 면의 방향이다 (모서리면 대각선).
function wallContact(p0, wall, bulletRadius) {
  const dx = wall.x - p0.x;
  const dy = wall.y - p0.y;
  const reach = wall.half + bulletRadius;
  const tx = Math.abs(dx) > reach ? (Math.abs(dx) - reach) / Math.abs(dx) : 0;
  const ty = Math.abs(dy) > reach ? (Math.abs(dy) - reach) / Math.abs(dy) : 0;
  const t = Math.max(tx, ty);
  // 두 축이 거의 같은 순간에 닿으면 모서리에 맞은 것이다.
  const corner = Math.abs(tx - ty) < 0.02;
  const nx = (tx >= ty || corner) && dx ? -Math.sign(dx) : 0;
  const ny = (ty >= tx || corner) && dy ? -Math.sign(dy) : 0;
  return { t, x: p0.x + dx * t, y: p0.y + dy * t, nx, ny };
}

function animateSpread(shot, dir, spread, age) {
  const start = tileCenter(shot.from);
  if (!start) return;
  const cells = spreadCells(shot.from, dir, spread);
  const muzzle = cells.find((cell) => cell.muzzle);
  const mid = muzzle ? tileCenter(muzzle.key) : null;
  if (!mid) return; // 바로 앞이 판 밖이면 날아갈 곳이 없다
  const mine = shot.by === myRole();
  const radius = start.half * 0.24;   // 총알 지름이 칸의 24%라서, 반지름은 칸 절반의 24%

  // 한 구간을 날아가는 총알 하나. skip 은 이미 지나간 시간(늦게 그리기 시작한 경우).
  // 끝나면 onEnd(late) — late 는 화면에 그리기도 전에 이미 끝났던 경우라 이펙트를 생략한다.
  const leg = (from, to, duration, skip, onEnd) => {
    if (skip >= duration) { onEnd(true); return; }
    const el = document.createElement("div");
    el.className = "bullet " + (mine ? "mine" : "foe");
    mapEl.appendChild(el);
    const at = (p) => `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    const anim = el.animate([{ transform: at(from) }, { transform: at(to) }],
      { duration: Math.max(1, duration), delay: -skip, fill: "forwards", easing: "linear" });
    anim.onfinish = () => { el.remove(); onEnd(false); };
  };

  // 1) 단발: 총알 한 발이 바로 앞 칸까지 날아간다. 그 칸이 벽이면 가장자리에서 멈춘다.
  if (isWall(muzzle.key)) {
    const contact = wallContact(start, mid, radius);
    leg(start, contact, spread.tileMs * contact.t, age, (late) => { if (!late) wallSpark(contact, mine); });
    return;
  }

  leg(start, mid, spread.tileMs, age, (late) => {
    // 2) 바로 앞 칸에 적이 서 있으면 퍼지지 않고 그 적에게 전부 맞는다 (근접).
    if (enemyAt(shot, muzzle.key)) {
      if (!late) unitSpark(mid, mine, true);
      return;
    }
    // 3) 비어 있으면 거기서 갈라져 앞의 칸들로 퍼진다. 한 발에 한 칸.
    const skip = Math.max(0, age - spread.tileMs);
    cells.filter((cell) => !cell.muzzle).forEach((cell) => {
      const end = tileCenter(cell.key);
      if (!end) return;
      const duration = spread.tileMs * Math.max(1, cell.d - 1);
      if (isWall(cell.key)) {
        const contact = wallContact(mid, end, radius);
        leg(mid, contact, duration * contact.t, skip, (lateHit) => { if (!lateHit) wallSpark(contact, mine); });
        return;
      }
      leg(mid, end, duration, skip, (lateHit) => {
        if (!lateHit && enemyAt(shot, cell.key)) unitSpark(end, mine, false);
      });
    });
  });
}

// 그 순간 그 칸에 쏜 쪽의 적이 서 있는지 (그림은 각자 자기 화면의 판을 보고 정한다).
function enemyAt(shot, key) {
  const battle = currentRoom && currentRoom.battle;
  if (!battle) return false;
  const enemies = battle[shot.by === "host" ? "guestPlacements" : "hostPlacements"] || {};
  return !!enemies[key];
}

// 구슬이 유닛에 부딪힌 자리. 번쩍 하고 작은 구슬 조각들이 사방으로 튄다.
// 근접(총알이 전부 한 번에 맞음)이면 더 크고 조각도 많다.
function unitSpark(center, mine, big) {
  if (!center) return;
  const el = document.createElement("div");
  el.className = "unit-hit " + (mine ? "mine" : "foe") + (big ? " big" : "");
  const count = big ? 8 : 5;
  const offset = Math.random() * 360;
  el.innerHTML = Array.from({ length: count }, (_, i) =>
    `<i style="--a:${Math.round(offset + (360 / count) * i)}deg"></i>`).join("");
  el.style.transform = `translate(${center.x}px, ${center.y}px) translate(-50%, -50%)`;
  mapEl.appendChild(el);
  setTimeout(() => el.remove(), 520);
}

// 벽 가장자리에 부딪힌 자리에 남는 불꽃. 벽 반대쪽(총알이 온 쪽)으로 튄다.
function wallSpark(contact, mine) {
  const el = document.createElement("div");
  el.className = "wall-hit " + (mine ? "mine" : "foe");
  el.innerHTML = `<i style="--a:-55deg"></i><i style="--a:0deg"></i><i style="--a:55deg"></i>`;
  // 그림은 위쪽으로 튀게 그려져 있으므로, 벽 면이 향한 방향으로 돌린다.
  const angle = Math.atan2(contact.nx, -contact.ny) * 180 / Math.PI;
  el.style.transform = `translate(${contact.x}px, ${contact.y}px) translate(-50%, -50%) rotate(${angle}deg)`;
  mapEl.appendChild(el);
  setTimeout(() => el.remove(), 420);
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
  return ammoOf(battle, myRole(), unit.slot ?? 0, unit.file) > 0;
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

// 화살표는 조준만 한다. 실제 공격은 스페이스.
// 같은 방향을 한 번 더 누르면 조준을 푼다.
function aimAt(dirKey) {
  if (moveInFlight || attackInFlight) return;
  if (aimDir === dirKey) {
    aimDir = null;
    renderBattle(currentRoom);
    return;
  }
  const battle = currentRoom && currentRoom.battle;
  const from = activeTile(battle);
  const unit = myUnitAt(battle, from);
  if (!unit) return;

  if (!attackOf(unit.file)) {
    pushNotice("이 유닛은 아직 공격할 수 없습니다.", { group: "attack", duration: 1800 });
    return;
  }
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

  if (!aimDir) {
    pushNotice("화살표로 공격 방향을 먼저 정하세요.", { group: "attack", duration: 1600 });
    return;
  }

  const from = activeTile(battle);
  const unit = myUnitAt(battle, from);
  const spec = attackOf(unit && unit.file);
  if (!unit || !spec) return;

  // 광역이면 사거리 안의 적을 모두, 단일이면 가장 가까운 적 하나만 때린다.
  // 적이 없어도 쏠 수 있다 (허공에 쏘면 탄창만 줄어든다). 벽 너머는 맞지 않는다.
  const opp = battle[oppField()] || {};
  const line = attackTiles(from, aimDir, unit.file);
  const inRange = spec.spread ? [] : untilWall(line).filter((t) => opp[t.key]);
  const targets = spec.splash ? inRange : inRange.slice(0, 1);

  const slot = unit.slot ?? 0;
  const ammo = ammoOf(battle, myRole(), slot, unit.file);
  if (ammo <= 0) {
    pushNotice("탄창이 비었습니다.\n잠시 뒤 한 발이 찹니다.", { group: "attack", duration: 2000 });
    return;
  }

  const oppRole = isHost ? "guest" : "host";
  const updates = {
    actedAt: serverTimestamp(),
    ...spendAmmo(battle, slot, unit.file)
  };

  // 산탄은 지금 피해를 넣지 않고 발사 기록만 남긴다. 총알이 도착하는 순간 판정한다.
  let shotId = null;
  const shotDir = screenDirection(aimDir);
  if (spec.spread) {
    shotId = push(ref(db, `rooms/${roomId}/battle/shots`)).key;
    updates[`shots/${shotId}`] = {
      by: myRole(), from, dir: DIR_NAME[shotDir.join(",")], unit: unitNumber(unit.file), at: serverTimestamp()
    };
  }

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
  if (spec.dot && targets.length) {
    updates[`burns/${targets[0].key}`] = { at: serverTimestamp(), by: myRole() };
  }
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

  attackInFlight = true;
  playSelect();
  const firedAt = Date.now();
  // 쏘는 순간 조준을 풀고 범위 표시를 바로 지운다 (서버 응답을 기다리지 않는다).
  aimDir = null;
  renderAttackRange(battle);
  try {
    await update(ref(db, `rooms/${roomId}/battle`), updates);
    // 총알은 쏜 순간부터 날아가고 있었으므로, 쓰기가 오간 시간만큼 당겨서 판정한다.
    if (shotId) resolveSpread(from, shotDir, spec.spread, shotId, Date.now() - firedAt);
    // 005의 튕김은 곧바로 들어가지 않고 1초 뒤에 옆 적에게 닿는다.
    // 그동안 그 적 위에 느낌표를 띄워 어디로 튀는지 보여준다.
    if (bounceTo) {
      setTimeout(() => applyLateDamage(bounceTo.key, bounceTo.damage, { bounceMark: null }), BOUNCE_DELAY_MS);
    }
    // 006처럼 자리에 남는 공격: 맞은 칸을 정해진 횟수만큼 계속 태운다.
    if (spec.dot && targets.length) scheduleDot(targets[0].key, spec.dot);
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
// 지금 타고 있는 칸들과, 그 불을 누가 붙였는지.
function burningTiles(battle) {
  const burns = (battle && battle.burns) || {};
  const now = serverNow();
  const out = {};
  Object.keys(burns).forEach((key) => {
    const cell = burns[key];
    const at = cell && cell.at;
    if (typeof at !== "number" || now - at >= BURN_VISIBLE_MS) return;
    out[key] = cell.by === myRole();   // true면 내가 붙인 불
  });
  return out;
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

// ---------- 매치 종료 -> 대기실 복귀 ----------
let finishSequenceStarted = false;
function handleFinish(battle) {
  if (battle.phase !== "finished" || finishSequenceStarted) return;
  finishSequenceStarted = true;
  matchFinished = true;

  clearInterval(countdownInterval);
  clearInterval(turnInterval);
  countdownOverlay.classList.add("hidden");
  turnBarEl.classList.add("hidden");

  // 왜 끝났는지 알려준다. 전멸로 끝났으면 이긴 쪽도 함께 보여준다.
  const timedOut = battle.endReason === "timeout";
  if (battle.endReason === "wipe") {
    matchEndTextEl.textContent =
      battle.winner === myRole() ? "승리" : battle.winner === "none" ? "무승부" : "패배";
  } else {
    matchEndTextEl.textContent = timedOut ? "시간 초과" : "매치 종료";
  }
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
  const wasHidden = battleMain.classList.contains("hidden");
  loadingOverlay.classList.add("hidden");
  battleMain.classList.remove("hidden");
  // 가려져 있는 동안에는 판 크기를 잴 수 없어 카메라를 못 맞췄으므로, 드러난 순간 맞춘다.
  if (wasHidden) {
    cameraPlaced = false;
    updateCamera(battle);
  }
}

// 호스트가 대표로 단계를 진행시킨다 (로딩 -> 카운트다운). 배치 단계는 없다.
// 카운트다운 동안 양쪽이 각자 첫 유닛을 스폰에 내보낸다.
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
        phase: "countdown",
        countdownStartedAt: serverTimestamp()
      });
    } else if (!loadingAdvanceTimer) {
      // 이 확인은 방 데이터가 바뀔 때(onValue)만 실행되는데, 로딩이 끝나기를 기다리는 동안에는
      // 아무 변화도 없어서 영영 다시 확인되지 않는다. 시간이 되면 스스로 다시 확인한다.
      loadingAdvanceTimer = setTimeout(() => {
        loadingAdvanceTimer = null;
        if (currentRoom) maybeAdvancePhase(currentRoom);
      }, LOADING_MIN_MS - elapsed);
    }
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

  if (battle.phase === "finished") {
    handleFinish(battle);
    return;
  }

  renderPhaseVisibility(battle);

  const myPlacements = battle[battleField()] || {};
  const oppPlacements = battle[isHost ? "guestPlacements" : "hostPlacements"] || {};

  playOpponentPlacementSfx(oppPlacements);

  const inMatch = battle.phase === "countdown" || battle.phase === "playing";
  sidebarBoxEl.classList.toggle("playing", inMatch);
  enemySidebarEl.classList.toggle("hidden", !inMatch);
  myEnergyEl.classList.toggle("hidden", battle.phase !== "playing");
  enemyEnergyEl.classList.toggle("hidden", battle.phase !== "playing");

  // 판에 나와 있는 내 유닛이 바뀌면(쓰러지고 다음 유닛이 나옴) 조준은 처음부터 다시.
  const outSlot = activeSlotOf(battle, myRole());
  if (outSlot !== activeSlot) aimDir = null;
  activeSlot = outSlot;
  if (!inMatch) prevHp = null;

  renderTurnSidebar();
  renderEnemySidebar(battle);
  renderMapTiles(myPlacements, oppPlacements);
  if (battle.phase === "playing") showDamage(battle);
  renderMoveHints(battle);
  renderAttackRange(battle);
  renderShots(battle);
  renderCountdown(battle);
  renderTurnBar(battle);
  updateCamera(battle);
  maybeSpawn(battle);
  if (battle.phase === "playing") checkWipe(battle);
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

