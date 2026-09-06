// 화면 한가운데에 떠오르는 알림 문구.
// 토스트(화면 아래에 하나만 잠깐 뜨는 것)와 달리, 놓치면 안 되는 소식(초대 거절/만료)에 쓴다.
// 배경 바 없이 글자만 보여주고, 무엇보다 위에 그려진다.
const STACK_ID = "notice-stack";
const LIFETIME_MS = 3500;
const EXIT_MS = 320;
const MAX_NOTICES = 4;

export function pushNotice(text, kind = "") {
  const stack = document.getElementById(STACK_ID);
  if (!stack) return;

  // 같은 문구가 이미 떠 있으면 새로 쌓지 않고 시간만 다시 채운다.
  // (버튼을 연달아 누르면 똑같은 실패 안내가 화면을 가득 채우기 때문)
  const same = alive(stack).find((el) => el.textContent === text);
  if (same) {
    scheduleRemoval(same);
    return;
  }

  const el = document.createElement("div");
  el.className = "notice-bar" + (kind ? " " + kind : "");
  el.textContent = text;
  stack.appendChild(el);

  // 나타나는 애니메이션은 다음 프레임에 클래스를 붙여야 동작한다.
  requestAnimationFrame(() => el.classList.add("show"));

  // 너무 많이 쌓이면 오래된 것부터 치운다.
  // 사라지는 중인 것은 아직 화면에 남아 있어도 이미 정리된 것으로 친다
  // (그렇지 않으면 개수가 줄지 않아 이 반복문이 끝나지 않는다).
  const list = alive(stack);
  while (list.length > MAX_NOTICES) remove(list.shift());

  scheduleRemoval(el);
}

function alive(stack) {
  return Array.from(stack.children).filter((el) => !el.dataset.removing);
}

function scheduleRemoval(el) {
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => remove(el), LIFETIME_MS));
}

function remove(el) {
  if (!el || el.dataset.removing) return;
  el.dataset.removing = "1";
  clearTimeout(Number(el.dataset.timer));
  // show를 떼면 나타날 때의 움직임이 그대로 거꾸로 재생된다 (아래로 내려가며 사라짐).
  el.classList.remove("show");
  setTimeout(() => el.remove(), EXIT_MS);
}
