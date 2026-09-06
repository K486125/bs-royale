import { firebaseConfig } from "./firebase-config.js";
import { unitFrameClass, unitNumber } from "./unit-colors.js";
import { playSelect } from "./sfx.js";
import {
  initChat, renderChat, newChatKey, chatRef,
  isLastLeaveNotice, noticeEntry, writeNotice, trimRootUpdates
} from "./chat.js";
import { initServerTime, serverNow, serverTimeReady, whenServerTime } from "./server-time.js";
import { pushNotice } from "./notice.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getDatabase, ref, set, update, remove, onValue, onDisconnect, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const AVATAR_PATH = "BS_Plr_Icons/";
const UNIT_SLOT_LABELS = ["유닛 1", "유닛 2", "유닛 3"];
const AVATARS = [
  "Shelly_001_Icon.png",
  "Nita_002_Icon.png",
  "Colt_003_Icon.png",
  "Bull_004_Icon.png",
  "Jessie_005_Icon.png",
  "Brock_006_Icon.png"
];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// 서버 시각 기준으로 남은 시간을 계산한다 (PC 시계가 어긋나 있어도 정확하도록).
initServerTime(db);
// 보정값이 늦게 도착하면 그동안 그려둔 요청 바의 남은 시간이 틀리므로 다시 그린다.
whenServerTime(() => {
  if (currentRoom) renderRequestBar(currentRoom, currentIsHost);
});

const params = new URLSearchParams(location.search);
const roomId = params.get("room");

let myUid = null;
let leaving = false;
let currentIsHost = false;
let currentRoom = null;

const myRowEl = document.getElementById("my-row");
const opponentRowEl = document.getElementById("opponent-row");
const requestBarEl = document.getElementById("request-bar");
const leaveBtn = document.getElementById("leave-btn");
const readyBtn = document.getElementById("ready-btn");
const toastEl = document.getElementById("toast");
const unitModal = document.getElementById("unit-modal");
const unitPickerRow = document.getElementById("unit-picker-row");
const unitCountEl = document.getElementById("unit-count");
const roomLoadingEl = document.getElementById("room-loading");

// 방 데이터가 도착해 화면이 처음 그려질 때까지 로딩 화면으로 덮어둔다.
// 너무 빨리 사라져 깜빡이지 않도록 최소 노출 시간을 둔다.
const ROOM_LOADING_MIN_MS = 700;
const roomLoadStartedAt = Date.now();
let roomLoadingDone = false;
let roomLoadingTimer = null;
function hideRoomLoading() {
  if (roomLoadingDone) return;
  roomLoadingDone = true;
  const wait = Math.max(0, ROOM_LOADING_MIN_MS - (Date.now() - roomLoadStartedAt));
  roomLoadingTimer = setTimeout(() => roomLoadingEl.classList.add("hidden"), wait);
}

function showRoomLoading(text) {
  // 들어올 때 예약된 '숨기기'가 뒤늦게 실행돼 이 화면을 지우지 않도록 취소한다.
  clearTimeout(roomLoadingTimer);
  roomLoadingEl.querySelector(".loading-text").textContent = text;
  roomLoadingEl.classList.remove("hidden");
}

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
  initChat({
    db,
    roomId,
    getMyUid: () => myUid,
    getIsHost: () => currentIsHost,
    getRoom: () => currentRoom
  });
  watchRoom();
});

function watchRoom() {
  const roomRef = ref(db, `rooms/${roomId}`);

  onValue(roomRef, (snap) => {
    const room = snap.val();
    if (leaving || navigatingToBattle) return;

    if (!room) {
      backToLobby("상대방이 방을 나갔습니다. 로비로 돌아갑니다.");
      return;
    }

    const isHost = room.hostUid === myUid;
    const isGuest = room.guestUid === myUid;
    if (!isHost && !isGuest) {
      backToLobby();
      return;
    }
    currentIsHost = isHost;
    currentRoom = room;

    updatePresence(isHost);
    watchOpponentPresence(room, isHost);

    const oppUid = isHost ? room.guestUid : room.hostUid;
    const oppOnline = isHost ? room.guestOnline : room.hostOnline;
    const oppNavigating = isHost ? room.guestNavigating : room.hostNavigating;
    // 화면 이동 중(navigating)이라 잠깐 끊긴 것과, 창을 꺼서 사라진 것을 구분한다.
    const opponentGone = !oppUid || (oppOnline === false && oppNavigating === false);

    if (room.battle) {
      // 둘 다 배치 화면으로 넘어가야 하는 시점 -> 대기실은 이제 볼 일이 없으니 바로 이동시킨다.
      if (!opponentGone) {
        goToBattle();
        return;
      }
      // 상대는 없는데 전투 데이터만 남은 경우(정리 실패 등). 혼자 전투 화면에 들어가면
      // 빠져나올 방법이 없으므로 들어가지 않고 지운다.
      // 이 화면(스냅샷)의 준비 상태는 아직 true이므로, 지운 직후에 아래 "둘 다 준비 완료"
      // 조건이 다시 전투를 만들어내지 않도록 여기서 갈라놓는다 (대기실↔전투 무한 왕복의 원인).
      if (oppUid) {
        // 상대 자리를 비우고 채팅에 퇴장 알림까지 남긴다 (전투 데이터도 여기서 지워진다).
        handleOpponentLeft();
      } else {
        update(roomRef, { battle: null, hostReady: false, guestReady: false })
          .catch((err) => console.error("남아있는 전투 데이터 정리 실패:", err));
      }
    } else if (isHost && room.hostReady && room.guestReady && !opponentGone) {
      // 둘 다 준비 완료되면 호스트가 대표로 배치 단계를 시작시킨다 (양쪽이 동시에 써서 충돌할 필요 없음).
      // 상대가 이미 사라진 상태라면 새 전투를 시작하지 않는다.
      update(roomRef, { battle: { phase: "loading", createdAt: serverTimestamp() } });
    }

    renderTeamScreen(room, isHost);
    renderRequestBar(room, isHost);
    renderChat(room, isHost);
    maybeAnnounceMatchEnd(room, isHost);
    hideRoomLoading();
  });

  leaveBtn.addEventListener("click", () => leaveRoom(roomRef));
  readyBtn.addEventListener("click", () => {
    const myReady = currentIsHost ? currentRoom.hostReady : currentRoom.guestReady;
    const myUnits = currentIsHost ? currentRoom.hostUnits : currentRoom.guestUnits;
    if (!myReady && !hasAllUnits(myUnits)) {
      // 준비 실패 안내는 여러 번 눌러도 가장 최근 것 하나만 보여준다.
      pushNotice(`실패: 유닛을 모두 장착 하세요 (${unitCount(myUnits)}/3)`, { group: "ready", duration: 2000 });
      return;
    }
    if (!myReady && hasDuplicateUnits(myUnits)) {
      pushNotice("실패: 중복 유닛을 확인하세요.", { group: "ready", duration: 2000 });
      return;
    }
    // 트랜잭션은 재시도 시 낙관적 업데이트가 여러 번 발생해 버튼이 깜빡이므로,
    // 단순 boolean 토글은 트랜잭션 없이 한 번에 값을 써서 부드럽게 처리한다.
    const field = currentIsHost ? "hostReady" : "guestReady";
    update(roomRef, { [field]: !myReady });
  });
}

// 매치가 끝나면 전투 화면이 matchEndPending 표시를 남긴다.
// 두 사람이 모두 대기실에 무사히 도착한 것을 확인한 뒤에 채팅에 알림을 남긴다.
let matchEndAnnounced = false;
function maybeAnnounceMatchEnd(room, isHost) {
  if (!isHost || !room.matchEndPending || matchEndAnnounced) return;
  if (!room.guestUid) return;                                     // 상대가 없음
  if (room.hostOnline === false || room.guestOnline === false) return; // 아직 도착 전
  matchEndAnnounced = true;

  // 채팅은 방 바깥(chats/{방ID})에 있으므로 최상위에서 두 곳을 한 번에 쓴다.
  // 한 번의 쓰기라 "알림만 남고 예약이 안 지워지는" 어긋남이 생기지 않는다.
  const key = newChatKey(db, roomId);
  update(ref(db), {
    [`rooms/${roomId}/matchEndPending`]: null,
    [`chats/${roomId}/${key}`]: noticeEntry("match"),
    ...trimRootUpdates(roomId, key)
  }).catch((err) => {
    matchEndAnnounced = false;
    console.error("매치 종료 알림 실패:", err);
  });
}

let navigatingToBattle = false;
async function goToBattle() {
  if (navigatingToBattle) return;
  navigatingToBattle = true;
  // 이동하는 동안 잠깐 끊기는 것을 상대가 "나갔다"고 오해하지 않도록 표시를 남긴다.
  await setNavigating(true);
  window.location.href = `battle.html?room=${roomId}`;
}

async function setNavigating(on) {
  if (!presenceRole) return;
  try {
    await update(ref(db, `rooms/${roomId}`), { [`${presenceRole}Navigating`]: on });
  } catch (err) {
    console.error("이동 표시 실패:", err);
  }
}

function unitAt(units, i) {
  return units ? units[i] : null;
}

function unitCount(units) {
  return [0, 1, 2].filter((i) => unitAt(units, i)).length;
}

function hasAllUnits(units) {
  return [0, 1, 2].every((i) => unitAt(units, i));
}

function hasDuplicateUnits(units) {
  const picked = [0, 1, 2].map((i) => unitAt(units, i)).filter(Boolean);
  return new Set(picked).size !== picked.length;
}

function identityCardHtml({ name, ready, barOverride, avatarFile, showCrown }) {
  const barClass = barOverride ? barOverride.cls : (ready ? "bar-ready" : "bar-not-ready");
  const barText = barOverride ? barOverride.text : (ready ? "준비 완료" : "준비 중");
  const avatarHtml = avatarFile
    ? `<img src="${AVATAR_PATH}${avatarFile}" alt="">`
    : "";
  const avatarClass = avatarHtml ? unitFrameClass(avatarFile) : "mystery";
  return `
    ${showCrown ? `<img class="host-crown" src="BS_UI_ZIP/Host_Crown_Icon.png" alt="방장">` : ""}
    <div class="identity-portrait">
      <div class="identity-avatar ${avatarClass}">${avatarHtml || "?"}</div>
    </div>
    <div class="card-label is-name">${escapeHtml(name)}</div>
    <div class="card-bar ${barClass}">${barText}</div>
  `;
}

function unitCardHtml({ isMystery, file, label, interactive, slot }) {
  const portrait = (!isMystery && file)
    ? `<div class="portrait-frame ${unitFrameClass(file)}"><img class="card-portrait" src="${AVATAR_PATH}${file}" alt=""></div>`
    : `<div class="card-mystery">?</div>`;
  const bar = interactive
    ? `<div class="card-bar bar-select select-slot" data-slot="${slot}">선택</div>`
    : `<div class="card-bar bar-hidden">?</div>`;
  return `${portrait}<div class="card-label">${label}</div>${bar}`;
}

// 카드 구성: [정체성(로비 프로필+준비 상태)] [유닛1] [유닛2] [유닛3]
function renderMyRow(name, avatarFile, units, ready, showCrown) {
  myRowEl.innerHTML = "";

  const identityLi = document.createElement("li");
  identityLi.className = "bs-card identity-card";
  identityLi.innerHTML = identityCardHtml({ name, ready, avatarFile, showCrown });
  myRowEl.appendChild(identityLi);

  for (let i = 0; i < 3; i++) {
    const li = document.createElement("li");
    li.className = "bs-card";
    li.innerHTML = unitCardHtml({
      isMystery: false, file: unitAt(units, i), label: UNIT_SLOT_LABELS[i], interactive: true, slot: i
    });
    myRowEl.appendChild(li);
  }

  myRowEl.querySelectorAll(".select-slot").forEach((el) => {
    el.addEventListener("click", () => openUnitPicker(Number(el.dataset.slot)));
  });
}

function unitPickCardMarkup(file) {
  return `
    <li class="bs-card">
      <div class="portrait-frame ${unitFrameClass(file)}"><img class="card-portrait" src="${AVATAR_PATH}${file}" alt=""></div>
      <div class="card-label">${unitNumber(file)}</div>
      <div class="card-bar bar-select pick-unit" data-file="${file}">선택</div>
    </li>
  `;
}

function openUnitPicker(slot) {
  // 지금은 모든 유닛이 항상 선택 가능하므로 보유 수 = 전체 수
  unitCountEl.textContent = `${AVATARS.length}/${AVATARS.length}`;
  unitPickerRow.innerHTML = AVATARS.map(unitPickCardMarkup).join("");
  unitPickerRow.scrollLeft = 0;
  unitPickerRow.querySelectorAll(".pick-unit").forEach((el) => {
    el.addEventListener("click", () => selectUnit(slot, el.dataset.file));
  });
  unitModal.classList.remove("hidden");
}

unitModal.addEventListener("click", (e) => {
  if (e.target === unitModal) unitModal.classList.add("hidden");
});

// 세로 마우스 휠로도 가로 스크롤이 되게 한다.
unitPickerRow.addEventListener("wheel", (e) => {
  if (e.deltaY === 0) return;
  e.preventDefault();
  unitPickerRow.scrollLeft += e.deltaY * 2.2;
}, { passive: false });

async function selectUnit(slot, file) {
  playSelect();
  const field = currentIsHost ? "hostUnits" : "guestUnits";
  const roomRef = ref(db, `rooms/${roomId}`);

  await runTransaction(roomRef, (room) => {
    if (!room) return room;
    const existing = room[field] || {};
    const units = [0, 1, 2].map((i) => (i === slot ? file : (existing[i] != null ? existing[i] : null)));
    room[field] = units;
    return room;
  });

  unitModal.classList.add("hidden");
}

// 상대 카드: 유닛 3개는 항상 익명("?") 처리. 정체성 카드(로비 프로필+닉네임+준비 상태)는 공개 정보라 그대로 노출.
// 아직 상대가 없으면 이름은 "???", 상태는 "초대 대기 중".
function renderOpponentRow(exists, name, avatarFile, ready, showCrown, typing) {
  opponentRowEl.innerHTML = "";

  const displayName = exists ? name : "???";
  let barOverride = exists ? null : { cls: "bar-waiting", text: "초대 대기 중" };
  if (exists && typing) barOverride = { cls: "bar-typing", text: "입력 중" };

  const identityLi = document.createElement("li");
  identityLi.className = "bs-card identity-card";
  identityLi.innerHTML = identityCardHtml({
    name: displayName, ready, barOverride, avatarFile: exists ? avatarFile : null, showCrown
  });
  opponentRowEl.appendChild(identityLi);

  for (let i = 0; i < 3; i++) {
    const li = document.createElement("li");
    li.className = "bs-card";
    li.innerHTML = unitCardHtml({ isMystery: true, label: UNIT_SLOT_LABELS[i], interactive: false });
    opponentRowEl.appendChild(li);
  }
}

function renderTeamScreen(room, isHost) {
  const myName = isHost ? room.hostName : room.guestName;
  const myAvatar = isHost ? room.hostAvatar : room.guestAvatar;
  const myUnits = isHost ? room.hostUnits : room.guestUnits;
  const myReady = isHost ? room.hostReady : room.guestReady;

  const oppExists = isHost ? !!room.guestUid : true;
  const oppName = isHost ? room.guestName : room.hostName;
  const oppAvatar = isHost ? room.guestAvatar : room.hostAvatar;
  const oppReady = isHost ? room.guestReady : room.hostReady;
  const oppTyping = isHost ? !!room.guestTyping : !!room.hostTyping;

  renderMyRow(myName, myAvatar, myUnits, myReady, isHost);
  // 상대가 채팅을 치는 동안에는 "준비 중" 대신 "입력 중"을 보여준다 (준비 완료 상태는 그대로 유지).
  renderOpponentRow(oppExists, oppName, oppAvatar, oppReady, !isHost, oppTyping && !oppReady);

  readyBtn.disabled = !oppExists;
  readyBtn.textContent = myReady ? "준비 완료" : "게임 준비";
  readyBtn.classList.toggle("is-ready", !!myReady);
}

function renderRequestBar(room, isHost) {
  if (!isHost || room.guestUid) {
    requestBarEl.classList.add("hidden");
    requestBarEl.innerHTML = "";
    return;
  }

  const reqs = room.requests || {};
  const firstUid = Object.keys(reqs)[0];
  if (!firstUid) {
    clearTimeout(requestExpireTimer);
    requestExpireTimer = null;
    requestBarEl.classList.add("hidden");
    requestBarEl.innerHTML = "";
    return;
  }

  const req = reqs[firstUid];
  // 서버 시간 보정값이 아직 안 왔으면 남은 시간을 계산할 수 없다. 이 PC 시계가 서버보다
  // 앞서 있으면 방금 온 요청도 "이미 만료"로 계산돼 게이지가 아예 안 보였다.
  // 보정값이 도착하면 위 리스너가 다시 그려주므로, 그전까지는 가득 찬 게이지만 보여준다.
  const remain = serverTimeReady()
    ? INVITE_TIMEOUT_MS - (serverNow() - (req.createdAt || serverNow()))
    : INVITE_TIMEOUT_MS;
  if (serverTimeReady() && remain <= 0) {
    // 이미 만료된 초대 -> 지우고 표시하지 않는다 (게스트 쪽에서도 스스로 거둬간다).
    expireRequest(firstUid);
    requestBarEl.classList.add("hidden");
    requestBarEl.innerHTML = "";
    return;
  }

  requestBarEl.classList.remove("hidden");
  requestBarEl.innerHTML = `
    <div class="req-row">
      <span class="req-text"><b>${escapeHtml(req.guestName)}</b>님의 참가 요청을 수락하시겠습니까?</span>
      <button class="accept-req">수락</button>
      <button class="decline-req">거절</button>
    </div>
    <div class="req-gauge"><div class="req-gauge-fill"></div></div>
  `;
  requestBarEl.querySelector(".accept-req").addEventListener("click", () => acceptRequest(firstUid, req));
  requestBarEl.querySelector(".decline-req").addEventListener("click", () => declineRequest(firstUid));

  // 남은 시간만큼 게이지를 오른쪽에서 왼쪽으로 줄인다.
  const fill = requestBarEl.querySelector(".req-gauge-fill");
  fill.style.transition = "none";
  fill.style.width = `${(remain / INVITE_TIMEOUT_MS) * 100}%`;
  void fill.offsetWidth; // 시작 너비를 확정시킨 뒤에 줄여야 게이지가 실제로 움직인다
  fill.style.transition = `width ${remain}ms linear`;
  fill.style.width = "0%";

  // 시간이 다 되면 방 데이터에는 아무 변화가 없으므로, 스스로 깨어나 요청을 정리한다.
  clearTimeout(requestExpireTimer);
  if (serverTimeReady()) {
    requestExpireTimer = setTimeout(() => expireRequest(firstUid), remain);
  }
}

// 초대는 10초만 유효하다 (게스트 쪽 타이머와 같은 값).
const INVITE_TIMEOUT_MS = 10000;
let requestExpireTimer = null;

function expireRequest(guestUid) {
  clearTimeout(requestExpireTimer);
  requestExpireTimer = null;
  update(ref(db, `rooms/${roomId}/requests`), { [guestUid]: null }).catch((err) => {
    console.error("만료된 초대 정리 실패:", err);
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

async function acceptRequest(guestUid, req) {
  const roomRef = ref(db, `rooms/${roomId}`);
  const joinKey = newChatKey(db, roomId);
  let result;
  try {
    result = await runTransaction(roomRef, (room) => {
      if (!room) return room;
      if (room.guestUid) return; // 이미 채워짐 -> 중단
      room.guestUid = guestUid;
      room.guestName = req.guestName;
      room.guestAvatar = req.guestAvatar;
      room.guestUnits = req.guestUnits || room.guestUnits;
      room.guestReady = false;
      room.playerCount = 2;
      room.status = "full";
      room.requests = null;
      // 이전 대화를 지우지 않는다. 대신 새 게스트는 자기 참가 알림부터 보게 한다.
      room.guestChatSince = joinKey;
      room.chat = null; // 예전 구조로 방 안에 남아있던 기록이 있으면 여기서 정리된다
      room.guestTyping = null;
      room.matchEndPending = null; // 지난 매치의 알림 예약이 남아 있으면 지운다
      return room;
    });
  } catch (err) {
    // 쓰기가 거부되면(주로 보안 규칙) 조용히 실패하지 않고 이유를 보여준다.
    console.error("참가 수락 실패:", err);
    showToast("참가를 수락하지 못했습니다: " + (err && err.message ? err.message : err));
    return;
  }
  if (!result.committed) {
    showToast("이미 다른 요청을 수락했습니다.");
    return;
  }

  // 자리가 확정된 뒤에 참가 알림을 남긴다 (수락이 무산되면 알림도 남지 않도록).
  try {
    await writeNotice(db, roomId, "join", { key: joinKey, uid: guestUid, name: req.guestName });
  } catch (err) {
    console.error("참가 알림 실패:", err);
  }
}

async function declineRequest(guestUid) {
  await update(ref(db, `rooms/${roomId}/requests`), { [guestUid]: null });
}

// 연결이 끊길 때 방을 직접 뜯어고치면(호스트 승계/초기화 등) 페이지 이동으로 잠깐 끊기는 것과
// 진짜 나간 것을 구분할 수 없다. 그래서 끊길 때는 "나 접속 중" 표시만 끄고,
// 상대가 실제로 나갔는지는 남아있는 쪽이 잠시 지켜본 뒤(GRACE) 판단한다.
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

// 상대가 화면 이동 중이라고 표시해 뒀으면 넉넉히 기다리고(이동에 1초 안팎 걸린다),
// 그런 표시 없이 끊겼다면 창을 꺼버린 것이므로 바로 처리한다.
const OPPONENT_GRACE_MS = 6000;
const OPPONENT_QUICK_MS = 400;
let opponentGoneTimer = null;

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
    pushNotice(`${oppName}님이 나갔습니다.`);
    handleOpponentLeft();
    // 표시가 아예 없으면(예전 데이터, 쓰기 실패) 섣불리 내보내지 않고 넉넉히 기다린다.
  }, oppNavigating === false ? OPPONENT_QUICK_MS : OPPONENT_GRACE_MS);
}

// 상대가 확실히 나갔을 때(창을 껐거나 컴퓨터가 꺼졌을 때), 남아있는 쪽이 방을 정리한다.
// 나간 사람의 자리를 실제로 비우고, 채팅에 퇴장 알림을 남긴다.
//
// 방 전체를 다시 쓰는 트랜잭션은 필드 하나만 규칙에 걸려도 통째로 거부돼서
// 정리가 통째로 실패한다. 어차피 이 시점에는 방에 나 혼자뿐이라 경합이 없으므로,
// 바뀌는 값만 골라 쓰는 방식이 훨씬 안전하다.
let opponentLeftInFlight = false;
async function handleOpponentLeft() {
  if (opponentLeftInFlight) return;

  const room = currentRoom || {};
  const isHost = currentIsHost;
  const oppUid = isHost ? room.guestUid : room.hostUid;
  const oppName = (isHost ? room.guestName : room.hostName) || "상대방";
  const stillGone = isHost ? room.guestOnline === false : room.hostOnline === false;
  if (!oppUid || !stillGone) return; // 그 사이 돌아왔으면 아무것도 하지 않는다

  opponentLeftInFlight = true;

  const updates = {
    // 나간 사람(게스트 자리)을 비운다
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

  try {
    await update(ref(db), rootUpdates);
  } catch (err) {
    console.error("상대 이탈 정리 실패:", err);
  }

  // 역할이 바뀌었을 수 있으니 온라인 표시를 새 역할 기준으로 다시 건다.
  presenceRole = null;
  opponentLeftInFlight = false;
}

// 나간 사람의 "입력 중" 표시가 남지 않도록 지운다.
function clearTyping(room) {
  room.hostTyping = null;
  room.guestTyping = null;
  room.matchEndPending = null; // 상대가 없어졌으면 남길 알림도 의미가 없다
}

function clearGuest(room) {
  room.guestUid = null;
  room.guestChatSince = null;
  room.guestNavigating = null;
  room.guestName = null;
  room.guestAvatar = null;
  room.guestUnits = null;
  room.guestReady = false;
  room.guestOnline = null;
}

async function leaveRoom(roomRef) {
  leaving = true;
  leaveBtn.disabled = true;
  showRoomLoading("로비로 나가는 중...");

  const room = currentRoom || {};
  const iAmHost = room.hostUid === myUid;
  const someoneRemains = iAmHost ? !!room.guestUid : !!room.hostUid;

  // 퇴장 알림은 방을 정리하기 "전"에 남긴다. 정리가 끝나면 나는 더 이상 이 방 사람이
  // 아니라서 채팅에 쓸 권한이 사라지기 때문이다.
  if (someoneRemains && !isLastLeaveNotice(myUid)) {
    try {
      await writeNotice(db, roomId, "leave", {
        uid: myUid,
        name: (iAmHost ? room.hostName : room.guestName) || "상대방"
      });
    } catch (err) {
      console.error("퇴장 알림 실패:", err);
    }
  }

  let committed = false;
  try {
    const result = await runTransaction(roomRef, leaveUpdater());
    committed = !!(result && result.committed);
  } catch (err) {
    console.error("방 나가기 정리 실패:", err);
  }

  // 정리가 실패하면 방에 내가 남아 있는 것으로 보여서, 로비에 도착하자마자 이 방으로
  // 다시 끌려들어간다. 그래서 실패했을 때는 꼭 필요한 것만 골라 한 번 더 시도한다.
  if (!committed) await forceLeave();

  // 아무도 안 남는 방이면 방과 함께 대화 기록도 지운다.
  if (!someoneRemains) {
    try {
      await remove(chatRef(db, roomId));
    } catch (err) {
      console.error("채팅 기록 삭제 실패:", err);
    }
  }

  backToLobby();
}

function leaveUpdater() {
  return (room) => {
    if (!room) return room;

    if (room.hostUid === myUid) {
      if (room.guestUid) {
        return {
          hostChatSince: room.guestChatSince || null,
          hostUid: room.guestUid,
          hostName: room.guestName,
          hostAvatar: room.guestAvatar,
          hostUnits: room.guestUnits,
          hostReady: false,
          hostOnline: room.guestOnline !== false,
          guestUid: null,
          guestName: null,
          guestAvatar: null,
          guestUnits: null,
          guestReady: false,
          playerCount: 1,
          status: "waiting",
          createdAt: room.createdAt,
          lastSeen: room.lastSeen || null
        };
      }
      return null; // 방에 아무도 안 남음 -> 삭제
    }

    if (room.guestUid === myUid) {
      room.chat = null; // 예전 구조로 방 안에 남아있던 기록 정리
      clearGuest(room);
      room.hostReady = false;
      room.playerCount = 1;
      room.status = "waiting";
      room.battle = null;
      clearTyping(room);
      return room;
    }

    return room;
  };
}

// 방 전체를 다시 쓰는 트랜잭션이 거부됐을 때를 위한 최소한의 정리.
async function forceLeave() {
  const room = currentRoom || {};
  const isHost = room.hostUid === myUid;

  try {
    if (isHost && !room.guestUid) {
      await remove(ref(db, `rooms/${roomId}`)); // 아무도 안 남음
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

    if (isHost) {
      // 남은 게스트가 방장이 된다.
      updates.hostUid = room.guestUid;
      updates.hostName = room.guestName;
      updates.hostAvatar = room.guestAvatar;
      updates.hostUnits = room.guestUnits || null;
      updates.hostOnline = room.guestOnline !== false;
      updates.hostChatSince = room.guestChatSince || null;
      updates.hostNavigating = null;
    }

    await update(ref(db, `rooms/${roomId}`), updates);
  } catch (err) {
    console.error("방 나가기 재시도 실패:", err);
  }
}
