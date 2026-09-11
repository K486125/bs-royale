// 캐릭터별 기본 수치.
// 유닛이 늘거나 값을 조정할 때 여기만 고치면 화면과 전투 계산이 함께 따라간다.
// (공격력, 사거리 같은 값도 나중에 여기에 나란히 둔다)
import { unitNumber } from "./unit-colors.js";

const MAX_HP = {
  "001": 6700, // Shelly
  "002": 7000, // Nita
  "003": 6900, // Colt
  "004": 8000, // Bull
  "005": 5500, // Jessie
  "006": 4500  // Brock
};

// 표에 없는 유닛이 들어와도 화면이 깨지지 않도록 기본값을 둔다.
const FALLBACK_MAX_HP = 6000;

// 공격 정보. 아직 001만 정해져 있다.
//   range  : 자기 칸을 뺀 사거리 (2 -> 자기 칸 포함 3타일)
//   damage : 거리별 피해. damage[0]은 한 칸 앞, damage[1]은 두 칸 앞.
const ATTACK = {
  "001": { range: 2, damage: [3000, 600] }
};

export function attackOf(file) {
  if (!file) return null;
  return ATTACK[unitNumber(file)] || null;
}

export function maxHp(file) {
  if (!file) return FALLBACK_MAX_HP;
  return MAX_HP[unitNumber(file)] || FALLBACK_MAX_HP;
}
