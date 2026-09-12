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
const ATTACK = {
  "001": { range: 2, splash: false, damage: [3000, 600] }, // 자기 칸 포함 3타일, 단일
  "002": { range: 2, splash: true, damage: 1500 },          // 자기 칸 포함 3타일, 광역
  "003": { range: 3, splash: false, damage: 2400 },         // 자기 칸 포함 4타일, 단일
  "004": { range: 1, splash: false, damage: 4000 },         // 자기 칸 포함 2타일(실제 1칸), 근접 단일
  "005": { range: 3, splash: false, damage: 2000, bounce: 0.6 },  // 자기 칸 포함 4타일, 한 번 튕김
  "006": {
    range: 4, splash: false, damage: 1300,                  // 자기 칸 포함 5타일, 단일
    dot: { damage: 300, ticks: 3, everyMs: 1000 }           // 맞은 자리에 3초간 1초마다 300
  }
};

export function attackOf(file) {
  if (!file) return null;
  return ATTACK[unitNumber(file)] || null;
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
