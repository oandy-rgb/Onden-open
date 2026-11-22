// The scheduled run's report (.github/workflows/ci.yml job scheduled-report): one comment on the one open issue labelled
// `scheduled-checks` on the public repo, opened when there is none. It names the jobs, the failing tests, the seed lines
// and the run link — never log text, which could carry a note's words. E2E reds already in
// packages/frontend/e2e/known-red-baseline.json are counted, not listed; a listed test is called removable only when
// the log shows it passing (✓), never because it is missing from the log.
// A run on another branch (a hand-started check of a CI change) goes to the job's summary page, not to the issue: the
// issue is main's record.
//   RUN_ID=<id> KIND=daily|weekly GH_TOKEN=… node scripts/ciScheduledReport.mjs [--dry-run]
// The report job runs inside the run it reports on, so the run is not finished yet: `gh run view --log-failed` refuses
// then. Each finished job's log is read on its own (actions/jobs/<id>/logs); a log that cannot be read is said, not skipped.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "scheduled-checks";
const MAX_COMMENT = 60_000; // GitHub refuses a comment over 65,536 characters
/** Jobs each kind does not start, so their `skipped` is expected (ci.yml `if:` on inputs.extended / inputs.fullstack). */
const NOT_IN = { daily: [/^Scheduled weekly/], weekly: [/^Scheduled — (fuzz|browser)/, /^Full-stack E2E/] };
const E2E_JOB = /E2E/;

const strip = (text) => text.replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, "");

/** One job's log → failing tests, passing E2E tests and seed lines. A line is `<time> <text>` (job log) or
 *  `<job>\t<step>\t<time> <text>` (`gh run view --log`); colour codes come as an escape byte or as the text `^[`. */
export function readJobLog(log) {
  const failed = new Set(); const passed = new Set(); const seeds = new Set();
  for (const raw of log.split("\n")) {
    const text = strip(raw.includes("\t") ? raw.split("\t")[2] ?? "" : raw).replace(/^\S+Z /, "");
    let m;
    if ((m = / FAIL +(\S+) > (.+?)\s*$/.exec(text))) failed.add(`${m[1]} › ${m[2]}`);
    else if ((m = /^\s+\d+\) (\[[\w-]+\] › [^ ]+?):\d+:\d+ › (.+?)(?: \(retry #\d+\))?[\s─]*$/.exec(text))) failed.add(`${m[1]} › ${m[2].replace(/[\s─]+$/, "")}`);
    else if ((m = /^\s+✓\s+\d+ (\[[\w-]+\] › [^ ]+?):\d+:\d+ › (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(text))) passed.add(`${m[1]} › ${m[2]}`);
    else if ((m = /^(\S+)\s+FAILED$/.exec(text.trim()))) failed.add(`browser-app › ${m[1]}`);
    // layout:audit names each violation outside its baseline, and a page it could not open; its selftest a failed case.
    else if ((m = /^新違規 (R\d+ \S+ @ \S+)\s*$/.exec(text))) failed.add(`layout-audit › ${m[1]}`);
    else if ((m = /^審核本身的問題：(.+?)：/.exec(text))) failed.add(`layout-audit › 打不開：${m[1]}`);
    else if ((m = /^FAIL {2}(R\d+ .+?)（(?:應該|不該)報/.exec(text))) failed.add(`layout-audit selftest › ${m[1]}`);
    if ((m = /\b([A-Z_]*SEED)=(\d+)/.exec(text))) seeds.add(`${m[1]}=${m[2]}`);
    else if ((m = /^\[fuzz\] seed=(\d+)/.exec(text))) seeds.add(`FUZZ_SEED=${m[1]}`);
  }
  return { failed, passed, seeds };
}

/** Only main's runs are posted to the issue; any other branch's report goes to its job summary. */
export const postsToIssue = (branch) => branch === "main";

/** The comment, from the run's jobs and a reader of one job's log (null when it cannot be read). */
export function compose({ kind, branch = "main", sha, url, jobs, readLog, known }) {
  const others = jobs.filter((j) => j.name !== "Scheduled — report");
  const red = others.filter((j) => ["failure", "cancelled", "timed_out"].includes(j.conclusion));
  const skipped = others.filter((j) => j.conclusion === "skipped" && !(NOT_IN[kind] ?? []).some((re) => re.test(j.name))).map((j) => j.name);
  const lines = [`**${kind === "weekly" ? "每週" : "每天"}的定期檢查** · ${branch} \`${sha.slice(0, 9)}\` · [這次的執行](${url})`, ""];
  const unread = [];
  const logs = new Map();
  for (const j of others.filter((x) => red.includes(x) || (E2E_JOB.test(x.name) && x.conclusion === "success"))) {
    const log = readLog(j);
    if (log === null) { if (red.includes(j)) unread.push(j.name); continue; }
    logs.set(j.name, readJobLog(log));
  }
  if (!red.length) lines.push(`全部 ${others.filter((j) => j.conclusion !== "skipped").length} 個工作通過。`);
  const seeds = new Set();
  for (const j of red) {
    const read = logs.get(j.name);
    for (const s of read?.seeds ?? []) seeds.add(s);
    const names = [...(read?.failed ?? [])].filter((t) => !(E2E_JOB.test(j.name) && t in known));
    const why = !read ? "：紀錄讀不到，看執行紀錄" : names.length ? "" : E2E_JOB.test(j.name) && read.failed.size ? "：只有清單上已知的紅" : "：沒有讀到測試名稱，看執行紀錄";
    lines.push(`- ❌ **${j.name}**（${j.conclusion}）${why}`);
    for (const t of names.slice(0, 40)) lines.push(`  - \`${t}\``);
    if (names.length > 40) lines.push(`  - …另外 ${names.length - 40} 個`);
  }
  const e2e = [...logs].filter(([name]) => E2E_JOB.test(name)).map(([, r]) => r);
  if (e2e.length) {
    const failed = new Set(e2e.flatMap((r) => [...r.failed]));
    const passed = new Set(e2e.flatMap((r) => [...r.passed]));
    const fresh = [...failed].filter((t) => !(t in known));
    const hit = [...failed].filter((t) => t in known);
    const removable = Object.keys(known).filter((t) => passed.has(t) && !failed.has(t));
    lines.push("", `E2E：新的紅 ${fresh.length} 個；已知的紅 ${hit.length} 個（\`packages/frontend/e2e/known-red-baseline.json\`）。`);
    if (removable.length) lines.push("這次看到通過、可以從已知清單刪掉的：", ...removable.map((t) => `  - \`${t}\``));
  }
  if (unread.length) lines.push("", `紀錄讀不到的工作：${unread.join("、")}`);
  if (seeds.size) lines.push("", "失敗的工作用到的隨機種子（重跑用）：", ...[...seeds].map((s) => `- \`${s}\``));
  if (skipped.length) lines.push("", `不該略過卻沒有跑的工作：${skipped.join("、")}`);
  const text = lines.join("\n");
  return text.length > MAX_COMMENT ? `${text.slice(0, MAX_COMMENT)}\n\n…（太長，後面略過；看執行紀錄）` : text;
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? "oandy-rgb/Onden-open";
  const runId = process.env.RUN_ID;
  const kind = process.env.KIND ?? "daily";
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const run = JSON.parse(gh("run", "view", runId, "--repo", repo, "--json", "jobs,headSha,headBranch,url"));
  const readLog = (job) => {
    try { return gh("api", `repos/${repo}/actions/jobs/${job.databaseId}/logs`, "--allow-escape-sequences"); } catch { return null; }
  };
  const known = JSON.parse(readFileSync(join(root, "packages/frontend/e2e/known-red-baseline.json"), "utf8")).tests ?? {};
  const text = compose({ kind, branch: run.headBranch, sha: run.headSha, url: run.url, jobs: run.jobs, readLog, known });
  if (process.argv.includes("--dry-run")) { console.log(text); return; }
  if (!postsToIssue(run.headBranch)) {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    console.log(text);
    return;
  }
  const open = JSON.parse(gh("issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--json", "number", "--limit", "1"));
  if (open.length) gh("issue", "comment", String(open[0].number), "--repo", repo, "--body", text);
  else {
    try { gh("label", "create", LABEL, "--repo", repo, "--color", "B60205", "--description", "每天、每週的定期檢查（ci.yml scheduled-report）"); } catch { /* exists */ }
    gh("issue", "create", "--repo", repo, "--title", "定期檢查", "--label", LABEL, "--body", text);
  }
  console.log(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
