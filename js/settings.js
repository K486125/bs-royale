// 소리 설정. 창을 닫았다 켜도 유지돼야 하므로 localStorage에 저장한다.
// (닉네임/프로필은 창마다 달라야 해서 sessionStorage를 쓰지만, 설정은 앱 전체에 하나뿐이다)
const KEY = "bs_audio_settings";

// 기본값은 실제 음원 크기를 재서 정했다. 이 조합이면 배경음악은 은은하게 깔리고,
// 효과음이 그보다 2dB 남짓 크게 들린다 (100은 최대치로 남겨둔다).
export const DEFAULT_SETTINGS = {
  musicOn: true,
  musicVolume: 35,
  sfxOn: true,
  sfxVolume: 55
};

function clampVolume(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function loadSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch (e) {
    stored = null;
  }
  if (!stored || typeof stored !== "object") return { ...DEFAULT_SETTINGS };

  return {
    musicOn: stored.musicOn !== false,
    musicVolume: clampVolume(stored.musicVolume, DEFAULT_SETTINGS.musicVolume),
    sfxOn: stored.sfxOn !== false,
    sfxVolume: clampVolume(stored.sfxVolume, DEFAULT_SETTINGS.sfxVolume)
  };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch (e) {
    // 저장에 실패해도 이번 실행 동안은 설정이 적용되므로 조용히 넘어간다.
  }
}
