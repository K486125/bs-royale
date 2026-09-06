import { loadSettings } from "./settings.js";

// 효과음. 화면(로비/대기실/배치)마다 각자 불러 쓴다.
//
// 음원이 아주 작게 녹음돼 있어도 들리도록, 파일을 디코딩한 뒤 실제 최대 진폭을 재서
// 목표 크기에 맞게 증폭한다(<audio>의 volume은 1.0을 넘길 수 없어 이 방식이 필요하다).
// 나중에 제대로 정규화된 파일로 교체하면 증폭 배율이 자동으로 1에 가까워진다.
// 효과음 원본이 배경음악보다 8dB 가까이 크게 녹음돼 있고 짧고 날카로워서 체감이 더 크다.
// 음악과 나란히 들었을 때 튀지 않는 기준 크기로 맞춘다.
const TARGET_PEAK = 0.35;
const MAX_GAIN = 64;
const SILENCE_RATIO = 0.05; // 최대 진폭의 5% 미만은 앞부분 묵음으로 간주

let ctx = null;
let buffer = null;
let gain = 1;
let startOffset = 0;

async function load() {
  ctx = new AudioContext();
  const res = await fetch("SFX/Select_SFX.mp3");
  buffer = await ctx.decodeAudioData(await res.arrayBuffer());

  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak === 0) return;

  gain = Math.min(TARGET_PEAK / peak, MAX_GAIN);

  // 앞쪽 묵음만큼 건너뛰어야 클릭한 순간 바로 소리가 난다.
  const first = buffer.getChannelData(0);
  const threshold = peak * SILENCE_RATIO;
  for (let i = 0; i < first.length; i++) {
    if (Math.abs(first[i]) >= threshold) {
      startOffset = i / buffer.sampleRate;
      break;
    }
  }
}

const ready = load().catch((err) => {
  console.error("효과음을 불러오지 못했습니다:", err);
});

export async function playSelect() {
  // 설정은 언제든 바뀔 수 있으므로 재생할 때마다 읽는다 (클릭 때만 실행되니 부담 없다).
  const { sfxOn, sfxVolume } = loadSettings();
  if (!sfxOn || sfxVolume === 0) return;

  await ready;
  if (!buffer) return;
  if (ctx.state === "suspended") await ctx.resume();

  // 연달아 눌러도 서로 끊기지 않도록 매번 새 소스로 재생한다.
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const amp = ctx.createGain();
  amp.gain.value = gain * (sfxVolume / 100);
  source.connect(amp).connect(ctx.destination);
  source.start(0, startOffset);
}
