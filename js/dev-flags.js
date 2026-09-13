// 개발용 편의 기능을 켜고 끄는 스위치.
//
// 이 파일 하나만 브랜치마다 다르다.
//   main (공유용) : false — 자동 배치도, 기본 장착도 없다. 받는 사람이 직접 고른다.
//   dev  (개발용) : true  — 자동 배치와 기본 장착으로 빠르게 시험한다.
//
// 그냥 git merge 하면 반대편의 값이 따라오므로, 브랜치 사이 이동은 반드시 아래로 한다.
//   npm run sync-share   dev -> main  (스위치 끔)
//   npm run sync-dev     main -> dev  (스위치 켬, 릴리스 뒤 버전을 가져올 때)
// 배포 전에도 npm run release 가 main 의 스위치를 한 번 더 확인한다.
export const DEV_TOOLS = true;

// 개발 중 기본으로 장착해 둘 유닛 (DEV_TOOLS 가 켜져 있을 때만 쓴다).
// 0부터 세는 번호다. [3, 4, 5] 는 004~006.
export const DEV_DEFAULT_UNITS = [3, 4, 5];
