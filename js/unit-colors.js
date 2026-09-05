// 001(Shelly)은 하늘색 계열, 002~006은 연두색 계열 배경 프레임을 쓴다.
export function unitFrameClass(file) {
  if (file && file.includes("001")) return "";
  return "frame-green";
}

export function unitNumber(file) {
  const m = file.match(/_(\d{3})_/);
  return m ? m[1] : "";
}
