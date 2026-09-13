// 두 브랜치 사이에서 작업을 옮기고, 도착한 브랜치의 개발용 스위치를 제자리에 둔다.
//
//   npm run sync-share   dev 의 작업을 main(공유용)으로.  스위치를 끈다.
//   npm run sync-dev     main 의 변경(릴리스 버전 등)을 dev 로.  스위치를 켠다.
//
// 그냥 git merge 를 하면 반대편의 스위치 값이 따라온다.
// (git 은 "마지막으로 바꾼 쪽"의 값을 가져가서, 양방향 모두 뒤집힌다)
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FLAGS = path.join(ROOT, "js", "dev-flags.js");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const TARGETS = {
  share: { into: "main", from: "dev", value: false, label: "공유용(main)" },
  dev:   { into: "dev", from: "main", value: true,  label: "개발용(dev)" }
};
const target = TARGETS[process.argv[2]];

function fail(msg) {
  console.error("\n실패: " + msg);
  process.exit(1);
}

if (!target) fail("사용법: node scripts/sync-branch.js share|dev");

const dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty) fail("저장하지 않은 변경이 있습니다. 먼저 정리하세요.\n" + dirty);

const before = git("rev-parse", "--abbrev-ref", "HEAD");
git("checkout", target.into);
console.log(`${target.into} 로 이동 (${target.from} 을 합칩니다)`);

try {
  const out = git("merge", target.from, "--no-edit");
  console.log(out);
} catch (err) {
  // 스위치 파일만 부딪혔다면 스스로 푼다: 넘어오는 쪽 내용을 받고, 스위치만 이 브랜치 값으로 맞춘다.
  // 다른 파일이 부딪혔으면 손대지 않고 합치기 전 상태로 되돌린 뒤 멈춘다 (반쯤 합쳐진 채 두지 않는다).
  let conflicted = [];
  try {
    conflicted = git("diff", "--name-only", "--diff-filter=U").split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean);
  } catch (e) { /* 합치기 자체가 시작되지 않은 경우 */ }

  const onlyFlags = conflicted.length === 1 && conflicted[0] === "js/dev-flags.js";
  if (!onlyFlags) {
    try { git("merge", "--abort"); } catch (e) { /* 이미 정리됨 */ }
    try { git("checkout", before); } catch (e) { /* 그대로 둔다 */ }
    fail("합치는 중 충돌이 났습니다" +
      (conflicted.length ? ` (${conflicted.join(", ")})` : "") +
      ". 합치기 전 상태로 되돌렸습니다. 직접 해결한 뒤 다시 실행하세요.");
  }
  git("checkout", "--theirs", "js/dev-flags.js");
  git("add", "js/dev-flags.js");
  git("commit", "--no-edit");
  console.log("스위치 파일의 충돌을 넘어온 쪽 내용으로 풀었습니다 (값은 아래에서 맞춥니다).");
}

const want = `export const DEV_TOOLS = ${target.value};`;
const other = `export const DEV_TOOLS = ${!target.value};`;
const src = fs.readFileSync(FLAGS, "utf8");
if (src.includes(other)) {
  fs.writeFileSync(FLAGS, src.replace(other, want));
  git("add", "js/dev-flags.js");
  git("commit", "-m", target.value
    ? "Keep the development switch on for the dev branch"
    : "Keep the development switch off on the shared branch");
  console.log(`개발용 스위치를 ${target.value ? "켰습니다" : "껐습니다"}.`);
} else {
  console.log(`개발용 스위치는 이미 ${target.value ? "켜져" : "꺼져"} 있습니다.`);
}

if (!fs.readFileSync(FLAGS, "utf8").includes(want)) {
  fail("스위치를 맞추지 못했습니다. js/dev-flags.js 를 직접 확인하세요.");
}

console.log(`\n${target.label} 준비 완료. 올리려면: git push`);
if (before !== target.into) console.log(`원래 브랜치로 돌아가려면: git checkout ${before}`);
