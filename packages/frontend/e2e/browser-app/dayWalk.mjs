// npm run build:browser (repo root), then: node e2e/browser-app/dayWalk.mjs [<profile>] [--dir dist-browser] [--shots <dir>]
// A student's day, walked as ONE continuous session in real Chromium against the browser version, from an empty profile:
// open the site → create panel → write a note (at a person's pace, then as fast as the driver can) → upload a PDF → look at the
// tasks page → search → handwriting tab with one stroke → enlarge it → reload. After each step it asserts what a person would
// check with their eyes. The point is the assembly: every part has its own tests; this goes through them without resetting.
// <profile>: `tablet-landscape` (1280×800, 2 device pixels, touch — layout-audit/env.mjs PROFILES) or a VIEWPORTS id such as `1280` (desktop).
// Other days and other users are new lists of the same steps (walk/steps.mjs), not copies. Exit code 1 when a check fails.
// Reading it: ok = passed, FAIL = failed, XFAIL = red today for the reason written next to it (the run still passes; it fails
// when the line turns green so the expectation is deleted), SEE = written down, not judged.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { PROFILES, VIEWPORTS } from "../layout-audit/env.mjs";
import { startWalk } from "./walk/kit.mjs";
import { makePdf } from "./walk/pdf.mjs";
import * as s from "./walk/steps.mjs";

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const profileId = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "tablet-landscape";
const profile = PROFILES[profileId] ?? VIEWPORTS.find((v) => v.id === profileId && !v.mobile);
if (!profile) { console.log(`unknown profile ${profileId}: ${[...Object.keys(PROFILES), ...VIEWPORTS.filter((v) => !v.mobile).map((v) => v.id)].join(", ")}`); process.exit(2); }
const dir = arg("--dir") ?? "dist-browser";
// --prefix /onden/ serves the folder from a sub-path the way a preview address does (the PDF worker once asked for the host's root).
const prefix = arg("--prefix") ?? "/";
const shots = arg("--shots");
if (shots) mkdirSync(shots, { recursive: true });

// Requests and errors the walk lets through, each with its reason. Anything else fails the last step.
const ALLOWED_PROBLEMS = [
  { kinds: ["http", "requestfailed", "console"], match: /initdb\.wasm/, reason: "the database engine asks for initdb.wasm on start; the packaged database never runs initdb (scripts/build-browser.mjs), so nothing waits for it — the same kind of miss as the PDF worker, but harmless today (a 404, the aborted request and the console line that go with it)" },
  // Found by the sub-path run (--prefix): the faces' stylesheet asks for /fonts/… from the host's root (src/styles/fonts.css), so a copy served
  // from a sub-folder loses its fonts. Not fixed here; allowed only on that run so the run shows everything else.
  ...(prefix !== "/" ? [{ kinds: ["http", "requestfailed", "console"], match: /\/fonts\/[\w.-]+\.woff2/, reason: "sub-path run: the fonts are asked for at the host's root (src/styles/fonts.css), so they are missing when the page is served from a sub-folder — the same kind of miss as the PDF worker, found by this run and not fixed here" }] : []),
];

/** The walk is this list. Another day is another list. */
const TODAY = [
  s.opensOnSampleNote,
  s.createPanelIsAnchored,
  s.createNoteAndType({ pace: s.PACE.human, title: "編譯器筆記" }),
  s.createNoteAndType({ pace: s.PACE.fast, title: "編譯器筆記（快速打字）" }),
  s.uploadsPdf({ makePdf, fileName: "lecture-notes.pdf" }),
  s.looksAtTasksPage,
  s.searchFindsByBodyWord({ query: s.BODY_WORD }),
  // One character finds less than two today (the search needs two); #1786 changes that.
  s.searchFindsByBodyWord({ query: s.BODY_WORD[0], expectFailReason: "一個字的搜尋只列最近筆記、不搜內文（修正在 PR #1786）" }),
  s.drawsOneStroke,
  s.enlargesAndRestores,
  s.reloadKeepsNoteTabAndInk,
  s.canvasFollowsPageWidth,
  s.nothingWentWrong,
];

const t0 = Date.now();
const walk = await startWalk({ profile, dir, prefix, allowedProblems: ALLOWED_PROBLEMS });
const { report } = walk;
report.log(`走一趟：${profile.label ?? profile.id}，${dir}，路徑 ${prefix}`);
const timings = [];
for (const [i, step] of TODAY.entries()) {
  report.step(step.name);
  const from = Date.now();
  try { await step.run(walk); }
  catch (error) { report.check(false, "這一步沒做完", String(error.message).split("\n")[0]); }
  timings.push([step.name, Date.now() - from]);
  if (shots) await walk.page.screenshot({ path: join(shots, `${profile.id}-${String(i + 1).padStart(2, "0")}.png`) }).catch(() => {});
}
const heap = await walk.cdp.send("Performance.enable").then(async () => (await walk.cdp.send("Performance.getMetrics")).metrics).catch(() => []);
const metric = (name) => Math.round((heap.find((m) => m.name === name)?.value ?? 0) / 1048576);
let chromiumMb = null;
try { chromiumMb = Math.round(execSync("ps -eo rss,comm | grep -i chrom | awk '{s+=$1} END {print s}'", { encoding: "utf8" }).trim() / 1024); } catch { /* ps not there */ }
await walk.close();

report.log(`\n== 數字\n總共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒；打開網站到可用 ${walk.marks.openedInMs} ms`);
report.log(timings.map(([n, ms]) => `  ${String(ms).padStart(6)} ms  ${n}`).join("\n"));
report.log(`記憶體：頁面 JS 堆積 ${metric("JSHeapUsedSize")} MB（總 ${metric("JSHeapTotalSize")} MB）；Chromium 全部程序 ${chromiumMb ?? "?"} MB；node ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
report.log(`\n${report.failures.length ? `失敗 ${report.failures.length} 項：\n- ${report.failures.join("\n- ")}` : "全部通過"}${report.expected.length ? `\n已知紅燈 ${report.expected.length} 項（XFAIL）：\n- ${report.expected.join("\n- ")}` : ""}`);
process.exit(report.failures.length ? 1 : 0);
