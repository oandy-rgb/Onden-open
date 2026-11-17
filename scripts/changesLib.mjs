// 「改了使用者看得到的東西，就在 changes/ 加一個檔案」的判斷（changes/README.md）。
// scripts/changes.mjs（npm run changes:check）與守門測試共用。
import { execFileSync } from 'node:child_process';

/** 使用者看得到的程式放這些目錄。 */
const USER_FACING = ['packages/frontend/src/', 'packages/site/src/'];
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const CHANGE_FILE = /^changes\/(?!README\.md$)[^/]+\.md$/;
/** PR 說明裡寫這句，就不要求更新說明。 */
export const SKIP_PHRASE = '不需要更新說明';

/** 測試與型別宣告檔（scripts/check-md-links.mjs 的「涵蓋」比對也用）。 */
export function isTestPath(path) {
  return TEST_PATH.test(path);
}

/** 這個路徑是不是使用者可能看得到的程式（測試與型別宣告不算）。 */
export function isUserFacingSource(path) {
  return USER_FACING.some((dir) => path.startsWith(dir)) && !TEST_PATH.test(path);
}

/**
 * @param {{ status: string, path: string }[]} entries `git diff --name-status` 的每一列
 * @returns {{ ok: boolean, touched: string[], added: string[] }}
 */
export function checkChanges(entries) {
  const touched = entries.filter((e) => !e.status.startsWith('D') && isUserFacingSource(e.path)).map((e) => e.path);
  const added = entries.filter((e) => e.status.startsWith('A') && CHANGE_FILE.test(e.path)).map((e) => e.path);
  return { ok: touched.length === 0 || added.length > 0, touched, added };
}

/** `git diff --name-status <base>...HEAD`（改名取新路徑）。 */
export function diffEntries(base = 'origin/main') {
  const out = execFileSync('git', ['diff', '--name-status', `${base}...HEAD`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.split('\n').filter(Boolean).map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status, path: paths[paths.length - 1] };
  });
}

/** 這次是不是明講不需要：`--skip`、環境變數 CHANGES_SKIP=1，或 PR 說明（PR_BODY）含 SKIP_PHRASE。 */
export function skipRequested(argv, env) {
  return argv.includes('--skip') || env.CHANGES_SKIP === '1' || (env.PR_BODY ?? '').includes(SKIP_PHRASE);
}
