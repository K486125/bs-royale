// 개발용 편의 기능을 켜고 끄는 스위치.
//
// 이 파일 하나만 브랜치마다 다르다.
//   main (공유용) : false — 자동 배치도, 기본 장착도 없다. 받는 사람이 직접 고른다.
//   dev  (개발용) : true  — 자동 배치와 기본 장착으로 빠르게 시험한다.
//
// dev 를 main 에 합치면 이 값도 따라오므로, 합치기는 반드시
//   npm run sync-share
// 로 한다 (합친 뒤 스위치를 꺼주고, 꺼졌는지 확인까지 한다).
// 배포 전에도 npm run release 가 한 번 더 확인한다.
export const DEV_TOOLS = true;

// 개발 중 기본으로 장착해 둘 유닛 (DEV_TOOLS 가 켜져 있을 때만 쓴다).
// 0부터 세는 번호다. [3, 4, 5] 는 004~006.
export const DEV_DEFAULT_UNITS = [3, 4, 5];
