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
//   spread : 산탄. 구슬 총알 여러 발이 날아가 각자 한 칸씩 맞힌다 (아래 Shelly 참고).
//            d 는 앞으로 몇 칸째, side 는 옆으로 몇 칸 벗어났는지, tileMs 는 한 칸 날아가는 시간.
//   projectile : 한 줄로 날아가는 발사체. tileMs 는 한 칸 날아가는 시간, look 은 모양.
//                pierce 가 true 면 지나가는 적을 모두 맞히고, false 면 처음 맞은 적에서 멈춘다. 벽에서는 늘 멈춘다.
//   burst  : 한 번 쏘면 count 발이 gapMs 간격으로 나간다. 각 발은 나가는 순간 유닛이 선 칸에서 출발한다.
const ATTACK = {
  // Shelly: 바로 앞 1칸, 그 앞 가로 3칸. 단발이라 한 발이 바로 앞 칸까지 간다.
  // 거기 적이 있으면 퍼지지 않고 그 적만 3000 (총알 셋의 합). 비어 있으면 세 발로 갈라져
  // 앞의 가로 3칸에 한 발씩, 그 칸들의 적이 모두 1000씩 맞는다.
  "001": {
    range: 2,
    spread: {
      tileMs: 750,   // 한 칸 0.75초 -> 가장 먼 2칸째까지 1.5초
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
  "004": { range: 1, splash: false, damage: 4000 },         // 자기 칸 포함 2타일(실제 1칸), 근접 단일
  "005": { range: 3, splash: false, damage: 2000, bounce: 0.6 },  // 자기 칸 포함 4타일, 한 번 튕김
  "006": {
    range: 4, splash: false, damage: 1900,                  // 자기 칸 포함 5타일, 단일
    dot: { damage: 350, ticks: 3, everyMs: 1000 }           // 맞은 자리에 3초간 1초마다 350
  }
};

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
  "006": 4000   // Brock
};
const FALLBACK_RELOAD_MS = 4500;

export { MAX_ENERGY, ENERGY_PER_SEC, MOVE_COST };

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
