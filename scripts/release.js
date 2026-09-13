// 버전 올리기 + 빌드 + GitHub Release 생성/업로드 + git push 까지 한 번에 처리한다.
// 사용법: npm run release            (patch 버전 올림, 예: 1.0.0 -> 1.0.1)
//         npm run release -- minor   (minor 버전 올림, 예: 1.0.0 -> 1.1.0)
//         npm run release -- major   (major 버전 올림)
const { execSync } = require("child_process");
const fs = require("fs");

// PATH가 방금 설치된 gh.exe를 아직 못 읽는 경우(터미널을 새로 열어도 캐시된 환경변수를 쓰는 경우 등)를
// 대비해, PATH에서 못 찾으면 기본 설치 경로를 직접 찾아 쓴다.
function resolveGh() {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return "gh";
  } catch (e) {
    const fallback = `${process.env.ProgramFiles || "C:\\Program Files"}\\GitHub CLI\\gh.exe`;
    if (fs.existsSync(fallback)) return `"${fallback}"`;
    throw new Error("gh(GitHub CLI)를 찾을 수 없습니다. 설치 후 컴퓨터를 재시작해보세요.");
  }
}
const gh = resolveGh();

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

const NEWLINE = String.fromCharCode(10);

function runCapture(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

const bump = process.argv[2] || "patch";
if (!["patch", "minor", "major"].includes(bump)) {
  console.error(`알 수 없는 버전 단위: ${bump} (patch/minor/major 중 하나)`);
  process.exit(1);
}

// 1) 커밋 안 된 변경사항이 있으면 먼저 커밋하도록 안내하고 중단 (실수로 묻히는 걸 방지)
// note.txt 같은 개인 메모용 untracked 파일은 배포와 무관하므로 검사에서 제외한다.
const status = runCapture("git status --porcelain --untracked-files=no");
if (status) {
  console.error("커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 스태시한 뒤 다시 실행하세요.");
  console.error(status);
  process.exit(1);
}

// 2) gh CLI 로그인 토큰을 electron-builder가 쓰는 GH_TOKEN 환경변수로 전달
let ghToken;
try {
  ghToken = runCapture(`${gh} auth token`);
} catch (e) {
  console.error("GitHub CLI 로그인이 필요합니다: gh auth login");
  process.exit(1);
}

// 3) 버전 올리기 (package.json 수정 + git commit + git tag vX.Y.Z 까지 npm이 알아서 함)
run(`npm version ${bump} -m "chore: release v%s"`);

// 4) 빌드 + GitHub Release 생성/업로드 (태그의 버전을 그대로 사용)
//    100MB짜리 설치 파일 업로드가 중간에 끊기는 일이 있어서, 실패하면 다시 시도한다.
//    (이미 올라간 파일은 덮어쓰므로 다시 돌려도 안전하다)
const buildEnv = { env: { ...process.env, GH_TOKEN: ghToken } };
let published = false;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    run("npm run dist -- --publish always", buildEnv);
    published = true;
    break;
  } catch (e) {
    console.error(`\n업로드가 실패했습니다 (${attempt}/3). 다시 시도합니다...`);
  }
}
if (!published) {
  console.error("빌드/업로드가 계속 실패했습니다. 위 로그를 확인하세요.");
  process.exit(1);
}

// 5) 정말 다 올라갔는지 확인한다.
//    릴리스는 숨긴 초안(draft)으로 만들어진다. 초안은 사용자에게 보이지 않으므로,
//    파일이 반쯤 올라간 사이에 누가 업데이트를 확인해도 "latest.yml 이 없다"는 오류가 나지 않는다.
//    (예전에는 공개부터 되고 파일이 뒤따라 올라가, 약 1분 동안 업데이트 확인이 실패했다)
const version = require("../package.json").version;
const tag = `v${version}`;
const REPO = "K486125/bs-royale";
const localFile = {
  [`BS-Royale-Setup-${version}.exe`]: `dist/BS Royale Setup ${version}.exe`,
  [`BS-Royale-Setup-${version}.exe.blockmap`]: `dist/BS Royale Setup ${version}.exe.blockmap`,
  "latest.yml": "dist/latest.yml"
};
const required = Object.keys(localFile);

// 초안은 태그로 찾을 수 없어서(아직 공개되지 않은 태그), electron-builder 와 같이 목록에서 찾는다.
function findRelease() {
  const out = runCapture(`${gh} api repos/${REPO}/releases --paginate --jq ".[] | select(.tag_name == \\"${tag}\\") | [.id, .draft] | @tsv"`);
  const line = out.split(NEWLINE).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const [id, draft] = line.split(String.fromCharCode(9));
  return { id, draft: draft === "true" };
}

function uploadedAssets(id) {
  const out = runCapture(`${gh} api repos/${REPO}/releases/${id}/assets --paginate --jq ".[].name"`);
  return out.split(NEWLINE).map((n) => n.trim()).filter(Boolean);
}

const release = findRelease();
if (!release) {
  console.error(`\n${tag} 릴리스를 찾지 못했습니다. GitHub Releases 를 확인하세요.`);
  process.exit(1);
}

let missing = required.filter((name) => !uploadedAssets(release.id).includes(name));
if (missing.length > 0) {
  console.log(`\n빠진 파일이 있어 직접 올립니다: ${missing.join(", ")}`);
  for (const name of missing) {
    run(`${gh} release upload ${tag} "${localFile[name]}" --clobber`);
  }
  missing = required.filter((name) => !uploadedAssets(release.id).includes(name));
  if (missing.length > 0) {
    console.error(`\n아직 올라가지 않은 파일: ${missing.join(", ")}`);
    console.error("릴리스는 숨긴 초안으로 남아 있어 사용자에게는 아무 영향이 없습니다. 다시 실행하세요.");
    process.exit(1);
  }
}
console.log(`\n업로드 확인 완료: ${required.join(", ")}`);

// 6) 커밋과 태그를 원격에 반영
//    (릴리스를 만들 때 GitHub이 태그를 먼저 만들어두는 경우가 있어, 태그 푸시 실패는 넘어간다)
run("git push");
try {
  run("git push --tags");
} catch (e) {
  console.log("(태그는 이미 원격에 있습니다)");
}

// 7) 파일 셋이 모두 올라간 것을 확인했으니 이제 공개한다. 이 순간부터 사용자에게 업데이트가 간다.
if (release.draft) {
  try {
    runCapture(`${gh} api -X PATCH repos/${REPO}/releases/${release.id} -F draft=false -f make_latest=true`);
  } catch (e) {
    console.error("\n초안을 공개하지 못했습니다. 아래 명령으로 직접 공개하세요 (파일은 모두 올라가 있습니다):");
    console.error(`  gh api -X PATCH repos/${REPO}/releases/${release.id} -F draft=false -f make_latest=true`);
    process.exit(1);
  }
  const after = findRelease();
  if (!after || after.draft) {
    console.error("\n공개 요청은 보냈지만 아직 초안으로 보입니다. GitHub Releases 에서 확인하세요.");
    process.exit(1);
  }
  console.log(`\n${tag} 공개 완료 (최신 릴리스로 지정).`);
} else {
  console.log(`\n${tag} 는 이미 공개된 릴리스입니다.`);
}

console.log("\n릴리스 완료. GitHub Releases에서 확인하세요: https://github.com/K486125/bs-royale/releases");
