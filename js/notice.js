// 화면 맨 위에 세로로 쌓이는 알림 바.
// 토스트(화면 아래에 하나만 잠깐 뜨는 것)와 달리, 놓치면 안 되는 소식(초대 거절/만료)에 쓴다.
const STACK_ID = "notice-stack";
const LIFETIME_MS = 6000;
const MAX_NOTICES = 4;

export function pushNotice(text, kind = "") {
  const stack = document.getElementById(STACK_ID);
  if (!stack) return;

  const el = document.createElement("div");
  el.className = "notice-bar" + (kind ? " " + kind : "");
  el.textContent = text;
  // 눌러서 바로 치울 수 있게 한다.
  el.addEventListener("click", () => remove(el));
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
  el.classList.remove("show");
  setTimeout(() => el.remove(), 250);
}
