// 효과음. 화면(로비/대기실/배치)마다 각자 불러 쓴다.
const selectSfx = new Audio("SFX/Select_SFX.mp3");
selectSfx.volume = 0.7;

export function playSelect() {
  // 연달아 눌렀을 때 이전 재생이 끝나기를 기다리지 않고 처음부터 다시 낸다.
  selectSfx.currentTime = 0;
  selectSfx.play().catch(() => {});
}
