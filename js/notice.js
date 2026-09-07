// 화면 한가운데에 떠오르는 알림 문구.
// 토스트(화면 아래에 하나만 잠깐 뜨는 것)와 달리, 놓치면 안 되는 소식(초대 거절/만료)에 쓴다.
// 배경 바 없이 글자만 보여주고, 무엇보다 위에 그려진다.
//
// pushNotice(문구, { group, duration })
//   group    같은 그룹의 알림은 하나만 남는다. 새로 부르면 그 자리에서 문구를 바꾸고
//            등장 애니메이션을 처음부터 다시 재생한다 (버튼 연타 대응).
//   duration 표시 시간 (ms)
//
// 알림이 여러 개 떠 있을 때, 하나가 사라지면서 자리가 갑자기 없어지면 나머지가 뚝 튄다.
// 그래서 나타날 때는 자리가 0에서 열리고, 사라질 때는 다시 0으로 접히게 해서
// 위아래 알림이 부드럽게 따라 움직이도록 한다.
// 반환값: 알림이 사라지는 애니메이션까지 끝나는 시점에 resolve되는 Promise.
//        (알림이 완전히 사라진 뒤에 로딩 화면으로 넘어가고 싶을 때 쓴다)
const STACK_ID = "notice-stack";
const LIFETIME_MS = 3000;
const EXIT_MS = 320;
const MAX_NOTICES = 4;

export function pushNotice(text, options = {}) {
  const stack = document.getElementById(STACK_ID);
  if (!stack) return Promise.resolve();

  const group = options.group || "";
  const duration = options.duration || LIFETIME_MS;

  // 같은 그룹(또는 완전히 같은 문구)이 이미 떠 있으면 새로 쌓지 않고 그것을 되살린다.
  const current = alive(stack).find((el) => (
    group ? el.dataset.group === group : el.textContent === text
  ));
  if (current) {
    current.textContent = text;
    replay(current);
    scheduleRemoval(current, duration);
    return done(duration);
  }

  const el = document.createElement("div");
  el.className = "notice-bar";
  el.textContent = text;
  if (group) el.dataset.group = group;
  stack.appendChild(el);
  appear(el);

  // 너무 많이 쌓이면 오래된 것부터 치운다.
  // 사라지는 중인 것은 아직 화면에 남아 있어도 이미 정리된 것으로 친다
  // (그렇지 않으면 개수가 줄지 않아 이 반복문이 끝나지 않는다).
  const list = alive(stack);
  while (list.length > MAX_NOTICES) remove(list.shift());

  scheduleRemoval(el, duration);
  return done(duration);
}

// 표시 시간 + 사라지는 애니메이션 시간 (+ 여유를 조금 둬서 확실히 사라진 뒤에 resolve)
// 붙자마자 높이를 0으로 접어뒀다가 원래 높이로 펴면서 등장시킨다.
// (붙인 직후 같은 작업 안에서 접기 때문에 큰 상태가 화면에 비치지 않는다)
function appear(el) {
  const height = el.offsetHeight;
  el.style.height = "0px";
  el.style.marginTop = "0px";
  void el.offsetWidth; // 시작 상태를 확정시킨다 (다음 프레임을 기다리지 않아도 된다)

  el.style.height = `${height}px`;
  el.style.marginTop = ""; // CSS에 정해둔 간격으로 되돌아가며 자리가 열린다
  el.classList.add("show");

  // 다 펴진 뒤에는 높이 제한을 풀어준다.
  // (문구가 바뀌어 길어져도 잘리지 않고, 글자 그림자도 상자 밖으로 온전히 나온다)
  setTimeout(() => {
    if (el.dataset.removing) return;
    el.style.height = "";
    el.style.overflow = "visible";
  }, EXIT_MS + 60);
}

// 사라질 때는 반대로 자리를 도로 접는다.
function collapse(el) {
  el.style.overflow = "hidden"; // 접히는 동안에는 글자가 상자 밖으로 삐져나오지 않게
  el.style.height = `${el.offsetHeight}px`;
  void el.offsetWidth;
  el.style.height = "0px";
  el.style.marginTop = "0px";
}

function done(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration + EXIT_MS + 40));
}

function alive(stack) {
  return Array.from(stack.children).filter((el) => !el.dataset.removing);
}

// 등장 애니메이션을 처음부터 다시 재생한다.
// 시작 위치로 되돌릴 때는 애니메이션을 잠깐 꺼야 아래로 스르륵 내려갔다 오지 않는다.
function replay(el) {
  el.style.transition = "none";
  el.classList.remove("show");
  void el.offsetWidth; // 시작 상태를 확정시킨다
  el.style.transition = "";
  requestAnimationFrame(() => el.classList.add("show"));
}

function scheduleRemoval(el, duration) {
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => remove(el), duration));
}

function remove(el) {
  if (!el || el.dataset.removing) return;
  el.dataset.removing = "1";
  clearTimeout(Number(el.dataset.timer));
  collapse(el);
  // show를 떼면 나타날 때의 움직임이 그대로 거꾸로 재생된다 (아래로 내려가며 사라짐).
  el.classList.remove("show");
  setTimeout(() => el.remove(), EXIT_MS);
}
