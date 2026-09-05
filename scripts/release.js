// 버전 올리기 + 빌드 + GitHub Release 생성/업로드 + git push 까지 한 번에 처리한다.
// 사용법: npm run release            (patch 버전 올림, 예: 1.0.0 -> 1.0.1)
//         npm run release -- minor   (minor 버전 올림, 예: 1.0.0 -> 1.1.0)
//         npm run release -- major   (major 버전 올림)
const { execSync } = require("child_process");

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

const bump = process.argv[2] || "patch";
if (!["patch", "minor", "major"].includes(bump)) {
  console.error(`알 수 없는 버전 단위: ${bump} (patch/minor/major 중 하나)`);
  process.exit(1);
}

// 1) 커밋 안 된 변경사항이 있으면 먼저 커밋하도록 안내하고 중단 (실수로 묻히는 걸 방지)
const status = runCapture("git status --porcelain");
if (status) {
  console.error("커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 스태시한 뒤 다시 실행하세요.");
  console.error(status);
  process.exit(1);
}

// 2) gh CLI 로그인 토큰을 electron-builder가 쓰는 GH_TOKEN 환경변수로 전달
let ghToken;
try {
  ghToken = runCapture("gh auth token");
} catch (e) {
  console.error("GitHub CLI 로그인이 필요합니다: gh auth login");
  process.exit(1);
}

// 3) 버전 올리기 (package.json 수정 + git commit + git tag vX.Y.Z 까지 npm이 알아서 함)
run(`npm version ${bump} -m "chore: release v%s"`);

// 4) 빌드 + GitHub Release 생성/업로드 (태그의 버전을 그대로 사용)
run("npm run dist -- --publish always", {
  env: { ...process.env, GH_TOKEN: ghToken }
});

// 5) 커밋과 태그를 원격에 반영
run("git push");
run("git push --tags");

console.log("\n릴리스 완료. GitHub Releases에서 확인하세요: https://github.com/K486125/bs-royale/releases");
