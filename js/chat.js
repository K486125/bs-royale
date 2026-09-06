// 대기실 전용 실시간 채팅.
//
// 기록은 방 노드(rooms/{id}/chat) 안에만 두기 때문에 방이 사라지면 채팅도 같이 사라진다.
// 방장이 바뀌거나 상대가 나가서 방이 1인 대기 상태로 돌아갈 때도 room.js에서 chat을 지운다.
// (새로 들어온 사람에게 이전 사람의 대화가 보이면 안 되기 때문)
import {
  ref, push, update, onDisconnect, runTransaction
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";
import { pushNotice } from "./notice.js";

const MAX_MESSAGES = 30; // 이만큼 쌓이는 순간
const KEEP_MESSAGES = 6; // 최근 이만큼만 남기고 위쪽 24개를 지운다
const MAX_LEN = 200;
const TYPING_IDLE_MS = 2500; // 이 시간 동안 입력이 없으면 "입력 중" 표시를 끈다

let db = null;
let roomId = null;
let getIsHost = () => false;
let getMyUid = () => null;
let getRoom = () => null;

let panelEl, toggleBtn, closeBtn, logEl, formEl, inputEl, badgeEl;
let open = false;
let unread = 0;
let renderedSig = "";
let lastSeenCount = 0;
let firstRender = true;
let shownKeys = new Set(); // 이미 화면에 그려진 메시지 키 (새로 온 것만 애니메이션)
let typingSent = false;
let typingTimer = null;

export function initChat(ctx) {
  db = ctx.db;
  roomId = ctx.roomId;
  getIsHost = ctx.getIsHost;
  getMyUid = ctx.getMyUid;
  getRoom = ctx.getRoom;

  panelEl = document.getElementById("chat-panel");
  toggleBtn = document.getElementById("chat-toggle");
  closeBtn = document.getElementById("chat-close");
  logEl = document.getElementById("chat-log");
  formEl = document.getElementById("chat-form");
  inputEl = document.getElementById("chat-input");
  badgeEl = document.getElementById("chat-badge");

  toggleBtn.addEventListener("click", () => setOpen(!open));
  closeBtn.addEventListener("click", () => setOpen(false));

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  // 채팅창 바깥(왼쪽 화면 아무 곳)을 누르면 닫는다. 여는 버튼 자체는 토글이므로 제외한다.
  document.addEventListener("mousedown", (e) => {
    if (!open) return;
    if (panelEl.contains(e.target) || toggleBtn.contains(e.target)) return;
    setOpen(false);
  });

  inputEl.addEventListener("input", onTyping);
  inputEl.addEventListener("blur", () => setTyping(false));
  // 대기실을 벗어나거나 창이 닫히면 "입력 중" 표시가 남지 않도록 지운다.
  window.addEventListener("pagehide", () => setTyping(false));
}

function setOpen(next) {
  open = next;
  panelEl.classList.toggle("collapsed", !open);
  toggleBtn.classList.toggle("active", open);
  if (open) {
    unread = 0;
    renderBadge();
    scrollToBottom();
    inputEl.focus();
  } else {
    setTyping(false);
  }
}

// ---------- 보내기 ----------
function myName() {
  const room = getRoom() || {};
  return (getIsHost() ? room.hostName : room.guestName) || "나";
}

async function send() {
  const text = inputEl.value.trim().slice(0, MAX_LEN);
  if (!text) return;

  inputEl.value = "";
  setTyping(false);

  const uid = getMyUid();
  const name = myName();
  // 키는 push가 만들어 주는 시간순 ID를 쓰되, 실제 쓰기는 트랜잭션 안에서 한다.
  // 그래야 "추가 + 오래된 것 정리"가 한 번에 이뤄져서 양쪽이 동시에 보내도 어긋나지 않는다.
  const key = push(ref(db, `rooms/${roomId}/chat`)).key;

  try {
    await runTransaction(ref(db, `rooms/${roomId}/chat`), (chat) => {
      const next = chat || {};
      next[key] = { uid, name, text };
      return trimChat(next);
    });
  } catch (err) {
    // 조용히 사라지면 보낸 줄 알기 때문에, 실패를 알리고 쓴 내용을 되돌려준다.
    console.error("메시지 전송 실패:", err);
    inputEl.value = text;
    pushNotice("메시지를 보내지 못했습니다.");
  }
}

// ---------- 다른 화면(대기실/전투)에서 쓰는 도우미 ----------
// 채팅 키는 push가 만드는 시간순 ID다. Firebase가 서버 시간으로 보정해 만들어 주기 때문에
// 양쪽 PC의 시계가 어긋나 있어도, 키를 정렬하면 "먼저 일어난 순"이 된다.
// 그래서 채팅과 퇴장 알림이 거의 동시에 생겨도 순서가 뒤바뀌지 않는다.
export function newChatKey(database, room) {
  return push(ref(database, `rooms/${room}/chat`)).key;
}

export function trimChat(chat) {
  const next = chat || {};
  const keys = Object.keys(next).sort();
  if (keys.length >= MAX_MESSAGES) {
    keys.slice(0, keys.length - KEEP_MESSAGES).forEach((k) => { delete next[k]; });
  }
  return next;
}

// 참가/퇴장 알림을 채팅 기록에 남긴다. 방을 정리하는 트랜잭션 안에서 호출한다.
// 나가는 본인과 남아있는 쪽이 동시에 알림을 넣으려 할 수 있으므로,
// 같은 사람의 같은 알림이 이미 마지막에 있으면 넣지 않는다.
function addNotice(chat, type, { key, uid, name }) {
  const next = chat || {};
  const keys = Object.keys(next).sort();
  const last = keys.length ? next[keys[keys.length - 1]] : null;
  if (last && last.type === type && last.uid === uid) return next;

  next[key] = { type, uid, name: name || "상대방" };
  return trimChat(next);
}

export function addLeaveNotice(chat, info) {
  return addNotice(chat, "leave", info);
}

export function addJoinNotice(chat, info) {
  return addNotice(chat, "join", info);
}

// 매치가 끝나고 두 사람이 모두 대기실로 돌아왔을 때 남기는 알림.
// 사람이 아니라 방에 일어난 일이라 uid가 없고, 매번 새로 남긴다.
export function addMatchEndNotice(chat, { key }) {
  const next = chat || {};
  next[key] = { type: "match" };
  return trimChat(next);
}

// ---------- 입력 중 표시 ----------
function onTyping() {
  setTyping(inputEl.value.length > 0);
  clearTimeout(typingTimer);
  if (typingSent) typingTimer = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
}

function setTyping(on) {
  if (typingSent === on) return;
  typingSent = on;
  if (!on) clearTimeout(typingTimer);

  const field = getIsHost() ? "hostTyping" : "guestTyping";
  const typingRef = ref(db, `rooms/${roomId}/${field}`);
  update(ref(db, `rooms/${roomId}`), { [field]: on });
  // 갑자기 끊겨도 상대 화면에 "입력 중"이 영원히 남지 않도록 해제를 예약해둔다.
  if (on) onDisconnect(typingRef).set(false);
}

// ---------- 그리기 ----------
export function renderChat(room, isHost) {
  const oppExists = isHost ? !!room.guestUid : !!room.hostUid;
  inputEl.disabled = !oppExists;
  inputEl.placeholder = oppExists ? "메시지를 입력하세요" : "상대가 들어오면 대화할 수 있습니다";

  const chat = room.chat || {};
  // 새로 들어온 사람에게는 참가 이전의 대화가 보이면 안 된다.
  // 방에 남아있던 사람은 그대로 다 보이므로, 기록을 지우는 대신 각자의 시작 지점만 다르게 둔다.
  // (채팅 키는 시간순이라 "내 시작 키보다 뒤"인 것만 고르면 된다)
  const since = isHost ? room.hostChatSince : room.guestChatSince;
  const keys = Object.keys(chat).sort().filter((k) => !since || k >= since);
  const sig = keys.join(",");
  if (sig === renderedSig) return; // 다른 값만 바뀐 경우 (준비 상태 등) 채팅은 다시 그리지 않는다
  renderedSig = sig;

  const myUid = getMyUid();
  logEl.innerHTML = keys.map((k) => {
    const m = chat[k] || {};
    if (m.type === "match") {
      return `<div class="chat-notice match" data-key="${k}">매치가 종료되었습니다.</div>`;
    }
    if (m.type === "leave" || m.type === "join") {
      const what = m.type === "join" ? "대기실에 참가했습니다." : "나갔습니다.";
      return `<div class="chat-notice ${m.type}" data-key="${k}">${escapeHtml(m.name || "상대방")}님이 ${what}</div>`;
    }
    const mine = m.uid === myUid;
    return `
      <div class="chat-msg ${mine ? "mine" : "theirs"}" data-key="${k}">
        <div class="chat-bubble">
          <span class="chat-who">${escapeHtml(mine ? "나" : (m.name || "상대방"))}:</span>
          <span class="chat-text">${escapeHtml(m.text)}</span>
        </div>
      </div>
    `;
  }).join("");

  // 목록 전체를 다시 그리기 때문에, 이번에 새로 생긴 것만 골라 등장 애니메이션을 준다.
  // (처음 화면에 들어왔을 때 이미 쌓여 있던 대화는 그냥 놓여 있어야 한다)
  if (!firstRender) {
    Array.from(logEl.children).forEach((el) => {
      if (!shownKeys.has(el.dataset.key)) el.classList.add("enter");
    });
  }
  shownKeys = new Set(keys);

  // 안 읽은 개수: 채팅창이 닫혀 있는 동안 새로 들어온 상대 메시지만 센다.
  // (전투에서 대기실로 돌아왔을 때처럼 이미 쌓여 있던 대화는 새 메시지가 아니다)
  const added = firstRender ? 0 : Math.max(0, keys.length - lastSeenCount);
  firstRender = false;
  if (!open && added > 0) {
    const newOnes = keys.slice(keys.length - added);
    unread += newOnes.filter((k) => {
      const m = chat[k] || {};
      return !m.type && m.uid !== myUid;
    }).length;
    renderBadge();
  }
  lastSeenCount = keys.length;

  scrollToBottom();
}

function renderBadge() {
  badgeEl.textContent = unread > 99 ? "99+" : String(unread);
  badgeEl.classList.toggle("hidden", unread === 0);
}

function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}
