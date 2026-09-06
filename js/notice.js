// 화면 한가운데에 떠오르는 알림 문구.
// 토스트(화면 아래에 하나만 잠깐 뜨는 것)와 달리, 놓치면 안 되는 소식(초대 거절/만료)에 쓴다.
// 배경 바 없이 글자만 보여주고, 무엇보다 위에 그려진다.
const STACK_ID = "notice-stack";
const LIFETIME_MS = 3500;
const MAX_NOTICES = 4;

export function pushNotice(text, kind = "") {
  const stack = document.getElementById(STACK_ID);
  if (!stack) return;

  const el = document.createElement("div");
  el.className = "notice-bar" + (kind ? " " + kind : "");
  el.textContent = text;
  stack.appendChild(el);

  // 나타나는 애니메이션은 다음 프레임에 클래스를 붙여야 동작한다.
  requestAnimationFrame(() => el.classList.add("show"));

  // 너무 많이 쌓이면 오래된 것부터 치운다.
  while (stack.children.length > MAX_NOTICES) remove(stack.firstElementChild);

  setTimeout(() => remove(el), LIFETIME_MS);
}

function remove(el) {
  if (!el || el.dataset.removing) return;
  el.dataset.removing = "1";
  // show를 떼면 나타날 때의 움직임이 그대로 거꾸로 재생된다 (아래로 내려가며 사라짐).
  el.classList.remove("show");
  setTimeout(() => el.remove(), 320);
}
