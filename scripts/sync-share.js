// dev 에서 만든 것을 공유용(main)으로 가져온다.
//
//   node scripts/sync-share.js      (= npm run sync-share)
//
// 합치기만 하면 dev 의 개발용 스위치까지 따라오기 때문에,
// 합친 뒤 스위치를 반드시 꺼두고 그 사실을 확인한 다음 끝낸다.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FLAGS = path.join(ROOT, "js", "dev-flags.js");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function fail(msg) {
  console.error("\n실패: " + msg);
  process.exit(1);
}

const dirty = git("status", "--porcelain");
if (dirty) fail("저장하지 않은 변경이 있습니다. 먼저 정리하세요.\n" + dirty);

const before = git("rev-parse", "--abbrev-ref", "HEAD");
console.log(`지금 브랜치: ${before}`);

git("checkout", "main");
console.log("main 으로 이동");

try {
  console.log(git("merge", "dev", "--no-edit"));
} catch (err) {
  fail("합치는 중 충돌이 났습니다. 직접 해결한 뒤 다시 실행하세요.");
}

// 합치면서 따라온 개발용 스위치를 끈다.
const src = fs.readFileSync(FLAGS, "utf8");
const off = src.replace("export const DEV_TOOLS = true;", "export const DEV_TOOLS = false;");
if (off !== src) {
  fs.writeFileSync(FLAGS, off);
  git("add", "js/dev-flags.js");
  git("commit", "-m", "Keep the development switch off on the shared branch");
  console.log("개발용 스위치를 껐습니다.");
} else {
  console.log("개발용 스위치는 이미 꺼져 있습니다.");
}

if (!fs.readFileSync(FLAGS, "utf8").includes("export const DEV_TOOLS = false;")) {
  fail("스위치를 끄지 못했습니다. js/dev-flags.js 를 직접 확인하세요.");
}

console.log("\n공유용(main) 준비 완료. 올리려면: git push");
console.log(`개발로 돌아가려면: git checkout ${before === "main" ? "dev" : before}`);
