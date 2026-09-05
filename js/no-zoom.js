// Ctrl+마우스 휠로 인한 브라우저 페이지 확대/축소만 차단한다.
// (Ctrl+/-, Ctrl+0 키보드 단축키는 브라우저가 보호하는 단축키라 JS로 막을 수 없음)
window.addEventListener("wheel", (e) => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });
