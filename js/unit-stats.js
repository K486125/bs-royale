// 캐릭터별 기본 수치.
// 유닛이 늘거나 값을 조정할 때 여기만 고치면 화면과 전투 계산이 함께 따라간다.
// (공격력, 사거리 같은 값도 나중에 여기에 나란히 둔다)
import { unitNumber } from "./unit-colors.js";

const MAX_HP = {
  "001": 6700, // Shelly
  "002": 7000, // Nita
  "003": 6900, // Colt
  "004": 8800, // Bull
  "005": 5900, // Jessie
  "006": 6300  // Brock
};

// 표에 없는 유닛이 들어와도 화면이 깨지지 않도록 기본값을 둔다.
const FALLBACK_MAX_HP = 6000;

// 공격 정보. 사거리는 "자기 칸을 뺀" 칸 수다 (2 -> 자기 칸 포함 3타일).
//   splash : true면 사거리 안의 적을 모두 때린다. false면 가장 가까운 하나만.
//   damage : 숫자면 거리와 상관없이 고정, 배열이면 거리별 피해(0번이 한 칸 앞).
//   bounce : 맞은 칸 주변으로 한 번 더 튕긴다. 값은 원래 피해에 대한 비율.
//   dot    : 맞은 자리에 남는 지속 피해 (damage를 everyMs마다 ticks번).
//   spread : 산탄. 한 발이 바로 앞 칸(총구)까지 가서, 거기 적이 있으면 그 적만 pointBlank 만큼 맞고
//            비어 있으면 갈라져 앞의 칸들에 한 발씩 떨어진다 (아래 Shelly, Bull 참고).
//            d 는 앞으로 몇 칸째, side 는 옆으로 몇 칸 벗어났는지, tileMs 는 한 칸 날아가는 시간
//            (끝 칸까지 tileMs x 2), muzzleMs 는 바로 앞 칸을 판정하는 시각 (0 이면 쏘는 즉시), look 은 모양.
//   projectile : 한 줄로 날아가는 발사체. tileMs 는 한 칸 날아가는 시간, look 은 모양.
//                pierce 가 true 면 지나가는 적을 모두 맞히고, false 면 처음 맞은 적에서 멈춘다. 벽에서는 늘 멈춘다.
//   burst  : 한 번 쏘면 count 발이 gapMs 간격으로 나간다. 각 발은 나가는 순간 유닛이 선 칸에서 출발한다.
const ATTACK = {
  // Shelly: 바로 앞 1칸, 그 앞 가로 3칸. 단발이라 한 발이 바로 앞 칸까지 간다.
  // 거기 적이 있으면 퍼지지 않고 그 적만 3000 (0.5초 뒤). 비어 있으면 세 발로 갈라져
  // 앞의 가로 3칸에 한 발씩, 그 칸들의 적이 모두 1000씩 맞는다 (1.5초에 끝 칸 도착).
  "001": {
    range: 2,
    spread: {
      tileMs: 750,      // 끝 칸까지 1.5초
      muzzleMs: 500,    // 바로 앞 칸은 0.5초 뒤
      pointBlank: 3000,
      look: "marble",
      bullets: [
        { d: 2, side: -1, damage: 1000 }, { d: 2, side: 0, damage: 1000 }, { d: 2, side: 1, damage: 1000 }
      ]
    }
  },
  // Nita: 에너지 볼. 앞으로 2칸을 1초에 날아가며 지나가는 적을 모두 1500씩 맞힌다. 벽은 못 뚫는다.
  "002": { range: 2, splash: true, damage: 1500, projectile: { tileMs: 500, pierce: true, look: "orb" } },
  // Colt: 자기 칸 포함 4타일 일자. 한 번에 총알 3발을 0.3초 간격으로, 한 발 800, 처음 맞은 적에서 멈춘다.
  // 쏘는 도중 움직이면 다음 총알은 옮긴 자리에서 나간다.
  // 0.3초: 이동은 서버 응답 뒤 0.25초가 지나야 다시 되므로, 통신 지연이 0.15초까지여도
  //        총알 사이마다 한 칸씩 옮겨 쏠 수 있는 가장 짧은 간격이다.
  "003": {
    range: 3, splash: false, damage: 800,
    projectile: { tileMs: 120, pierce: false, look: "slug" },
    burst: { count: 3, gapMs: 300 }
  },
  // Bull: Shelly 와 같은 범위(바로 앞 1칸, 그 앞 가로 3칸). 바로 앞 적은 쏘는 즉시 4000.
  // 비어 있으면 세 발로 갈라져 앞의 가로 3칸에 한 발씩 600 (2초에 끝 칸 도착).
  "004": {
    range: 2,
    spread: {
      tileMs: 1000,     // 끝 칸까지 2초
      muzzleMs: 0,      // 바로 앞 칸은 즉발
      pointBlank: 4000,
      look: "pellet",
      bullets: [
        { d: 2, side: -1, damage: 600 }, { d: 2, side: 0, damage: 600 }, { d: 2, side: 1, damage: 600 }
      ]
    }
  },
  // Jessie: 전기 볼. 자기 칸 포함 4타일, 최대 거리까지 1.75초. 처음 닿은 적(2000)이나 벽, 사거리 끝에서 멈추고
  // 주변 여덟 칸 중 한 곳으로 1초에 걸쳐 튕긴다 (옆에 적이 있으면 그 적, 없으면 판 안의 아무 칸).
  // 튕겨 닿은 칸에 적이 서 있으면 60% (1200).
  "005": {
    range: 3, splash: false, damage: 2000, bounce: 0.6,
    projectile: { tileMs: 1750 / 3, pierce: false, look: "zap" }
  },
  // Brock: 미사일. 자기 칸 포함 5타일, 끝 칸까지 2초, 단일 2000. 바로 앞 칸의 적은 즉발.
  // 미사일이 멈춘 자리에 불장판을 깐다: 적에 닿으면 그 칸, 벽이나 맵 끝에 막히면 그 앞 칸, 아니면 사거리 끝 칸.
  // 불장판은 1초마다 300씩 3번 (다 맞으면 2000 + 900 = 2900).
  "006": {
    range: 4, splash: false, damage: 2000,
    dot: { damage: 300, ticks: 3, everyMs: 1000 },
    projectile: { tileMs: 500, pierce: false, look: "missile", instantNear: true }
  }
};

// 탄창 수. 적힌 유닛만 다르고 나머지는 3발.
const AMMO = {
  "006": 4   // Brock: 탄창 4개 대신 재장전이 느리다
};
const DEFAULT_AMMO = 3;

// 에너지는 이동에만 쓴다 (사람마다 하나, 초당 10, 최대 100). 한 칸에 10.
// 공격은 에너지를 쓰지 않고 탄창과 재장전 시간으로만 제한한다.
const MAX_ENERGY = 100;
const ENERGY_PER_SEC = 10;
const MOVE_COST = 10;

// 탄창 한 발이 저절로 차는 데 걸리는 시간. 유닛마다 다르다.
const RELOAD_MS = {
  "001": 4000,  // Shelly
  "002": 4500,  // Nita
  "003": 4000,  // Colt
  "004": 5000,  // Bull
  "005": 4000,  // Jessie
  "006": 5000   // Brock (탄창이 4개라 더 느리게)
};
const FALLBACK_RELOAD_MS = 4500;

export { MAX_ENERGY, ENERGY_PER_SEC, MOVE_COST };

export function ammoMax(file) {
  return (file && AMMO[unitNumber(file)]) || DEFAULT_AMMO;
}

export function reloadMs(file) {
  if (!file) return FALLBACK_RELOAD_MS;
  return RELOAD_MS[unitNumber(file)] || FALLBACK_RELOAD_MS;
}

export function attackOf(file) {
  if (!file) return null;
  return ATTACK[unitNumber(file)] || null;
}

// 방 데이터의 발사 기록에는 파일 이름 대신 번호("001")만 적는다.
export function attackOfNumber(num) {
  return ATTACK[num] || null;
}

// 그 거리에서 실제로 들어가는 피해
export function damageAt(spec, distance) {
  if (!spec) return 0;
  return Array.isArray(spec.damage) ? (spec.damage[distance - 1] || 0) : spec.damage;
}

export function maxHp(file) {
  if (!file) return FALLBACK_MAX_HP;
  return MAX_HP[unitNumber(file)] || FALLBACK_MAX_HP;
}
