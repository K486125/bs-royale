import { firebaseConfig } from "./firebase-config.js";
import { unitFrameClass, unitNumber } from "./unit-colors.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getDatabase, ref, update, onValue, onDisconnect, runTransaction
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

const params = new URLSearchParams(location.search);
const roomId = params.get("room");

let myUid = null;
let currentDisconnectRef = null;
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

    const isHost = room.hostUid === myUid;
    const isGuest = room.guestUid === myUid;
    if (!isHost && !isGuest) {
      backToLobby();
      return;
    }
    currentIsHost = isHost;
    currentRoom = room;

    renderTeamScreen(room, isHost);
    renderRequestBar(room, isHost);
    updateDisconnectHandling(room, isHost);
  });

  leaveBtn.addEventListener("click", () => leaveRoom(roomRef));
  readyBtn.addEventListener("click", () => {
    const myReady = currentIsHost ? currentRoom.hostReady : currentRoom.guestReady;
    const myUnits = currentIsHost ? currentRoom.hostUnits : currentRoom.guestUnits;
    if (!myReady && hasDuplicateUnits(myUnits)) {
      showToast("같은 유닛이 중복 선택되어 있습니다. 유닛을 확인해주세요.");
      return;
    }
    // 트랜잭션은 재시도 시 낙관적 업데이트가 여러 번 발생해 버튼이 깜빡이므로,
    // 단순 boolean 토글은 트랜잭션 없이 한 번에 값을 써서 부드럽게 처리한다.
    const field = currentIsHost ? "hostReady" : "guestReady";
    update(roomRef, { [field]: !myReady });
  });
}

function unitAt(units, i) {
  return units ? units[i] : null;
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
function renderOpponentRow(exists, name, avatarFile, ready, showCrown) {
  opponentRowEl.innerHTML = "";

  const displayName = exists ? name : "???";
  const barOverride = exists ? null : { cls: "bar-waiting", text: "초대 대기 중" };

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

  renderMyRow(myName, myAvatar, myUnits, myReady, isHost);
  renderOpponentRow(oppExists, oppName, oppAvatar, oppReady, !isHost);

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
    requestBarEl.classList.add("hidden");
    requestBarEl.innerHTML = "";
    return;
  }

  const req = reqs[firstUid];
  requestBarEl.classList.remove("hidden");
  requestBarEl.innerHTML = `
    <span class="req-text"><b>${escapeHtml(req.guestName)}</b>님의 참가 요청을 수락하시겠습니까?</span>
    <button class="accept-req">네</button>
    <button class="decline-req">아니요</button>
  `;
  requestBarEl.querySelector(".accept-req").addEventListener("click", () => acceptRequest(firstUid, req));
  requestBarEl.querySelector(".decline-req").addEventListener("click", () => declineRequest(firstUid));
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

async function acceptRequest(guestUid, req) {
  const roomRef = ref(db, `rooms/${roomId}`);
  const result = await runTransaction(roomRef, (room) => {
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
    return room;
  });
  if (!result.committed) {
    showToast("이미 다른 요청을 수락했습니다.");
  }
}

async function declineRequest(guestUid) {
  await update(ref(db, `rooms/${roomId}/requests`), { [guestUid]: null });
}

function updateDisconnectHandling(room, isHost) {
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
        status: "waiting"
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
      status: "waiting"
    });
  }
  currentDisconnectRef = roomRef;
}

async function leaveRoom(roomRef) {
  leaving = true;
  leaveBtn.disabled = true;

  await runTransaction(roomRef, (room) => {
    if (!room) return room;

    if (room.hostUid === myUid) {
      if (room.guestUid) {
        return {
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
          createdAt: room.createdAt
        };
      }
      return null; // 방에 아무도 안 남음 -> 삭제
    }

    if (room.guestUid === myUid) {
      room.guestUid = null;
      room.guestName = null;
      room.guestAvatar = null;
      room.guestUnits = null;
      room.guestReady = false;
      room.playerCount = 1;
      room.status = "waiting";
      return room;
    }

    return room;
  });

  backToLobby();
}
