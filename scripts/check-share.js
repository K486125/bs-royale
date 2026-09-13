// 공유용(main)에서 개발용 스위치가 켜진 채로 배포되는 것을 막는다.
// 배포 전에 자동으로 한 번 확인한다 (package.json 의 prerelease).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const flags = fs.readFileSync(path.join(ROOT, "js", "dev-flags.js"), "utf8");
const on = /export const DEV_TOOLS = true;/.test(flags);

if (branch === "main" && on) {
  console.error("\n실패: 공유용(main)인데 개발용 스위치가 켜져 있습니다.");
  console.error("js/dev-flags.js 의 DEV_TOOLS 를 false 로 바꾼 뒤 다시 배포하세요.");
  process.exit(1);
}
console.log(`배포 전 확인: ${branch} 브랜치, 개발용 스위치 ${on ? "켜짐" : "꺼짐"}`);
