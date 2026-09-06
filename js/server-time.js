// 서버 시각 기준 시계.
//
// 사용자 PC의 시계는 얼마든지 어긋나 있을 수 있다(이 개발 PC는 서버보다 92초 빨랐다).
// 그래서 서버 타임스탬프(createdAt, placingStartedAt 등)와 Date.now()를 직접 빼면
// 방금 만든 것이 "이미 한참 지난 것"으로 계산되는 일이 생긴다.
//
// Firebase가 알려주는 오차(.info/serverTimeOffset)를 더해 쓰면 어떤 PC에서도 값이 맞는데,
// 이 값은 접속 직후에 도착하므로 "아직 모르는 동안"이 존재한다. 그 사이에 계산해버리면
// 보정이 안 된 상태라 똑같은 오류가 난다. 그래서 준비 여부를 같이 알려주고,
// 시간 계산이 필요한 쪽은 준비될 때까지 기다렸다가(whenServerTime) 계산하게 한다.
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

let offset = 0;
let ready = false;
let started = false;
let waiting = [];

export function initServerTime(db) {
  if (started) return;
  started = true;

  onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
    offset = snap.val() || 0;
    if (ready) return; // 이후 갱신은 값만 반영하면 된다
    ready = true;
    const pending = waiting;
    waiting = [];
    pending.forEach((fn) => {
      try { fn(); } catch (e) { console.error(e); }
    });
  });
}

export function serverNow() {
  return Date.now() + offset;
}

export function serverTimeReady() {
  return ready;
}

// 서버 시각을 쓸 수 있게 되면 실행한다 (이미 준비됐으면 즉시).
export function whenServerTime(fn) {
  if (ready) fn();
  else waiting.push(fn);
}
