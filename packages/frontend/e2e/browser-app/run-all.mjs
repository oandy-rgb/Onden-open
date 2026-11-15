#!/usr/bin/env node
// The browser app's smoke test in every engine this machine has: Chromium (desktop), Chromium with a phone window,
// WebKit (desktop Safari's engine) and WebKit with an iPhone window (Playwright's projects `webkit` and `mobile-safari`),
// then handwritingTab.mjs (the note's 「手寫」 tab; skipped where Chromium cannot start).
//   node e2e/browser-app/run-all.mjs [--dir dist-browser] [--store indexeddb]
// After that, the feature scripts listed in FEATURES below. Then e2e/browser-app/quoteRegion.mjs (quoting an area of a handwriting page) in Chromium and its phone window.
// An engine that cannot be started (smoke.mjs exits 2) is reported as SKIPPED, never as a pass; the exit code is 1
// if any engine that ran failed. WebKit cannot be downloaded in some sandboxes (docs/architecture/browser-app.md §15).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const smoke = join(dirname(fileURLToPath(import.meta.url)), "smoke.mjs");
const passthrough = process.argv.slice(2);
const summary = [];
for (const engine of ["chromium", "mobile-chrome", "webkit", "mobile-safari"]) {
  const run = spawnSync(process.execPath, [smoke, engine, ...passthrough], { stdio: "inherit" });
  summary.push([engine, run.status === 0 ? "passed" : run.status === 2 ? "SKIPPED (browser not available)" : "FAILED"]);
}
// The scripts that drive one feature end to end (Chromium and Chromium with a phone window); they take no engine
// they cannot run on, and a failure is a failure.
const quote = join(dirname(smoke), "quoteRegion.mjs");
for (const engine of ["chromium", "mobile-chrome"]) {
  const run = spawnSync(process.execPath, [quote, engine, ...passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir")], { stdio: "inherit" });
  summary.push([`quote ${engine}`, run.status === 0 ? "passed" : "FAILED"]);
}
// Text typed into an attribute box and a table cell survives the page being hidden and closed without a blur
// (Chromium, and Chromium with a Pixel 5 window, which is an emulation, not a phone).
const leave = join(dirname(smoke), "unsavedTextOnLeave.mjs");
for (const engine of ["chromium", "mobile-chrome"]) {
  const run = spawnSync(process.execPath, [leave, engine, ...passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir")], { stdio: "inherit" });
  summary.push([`leave ${engine}`, run.status === 0 ? "passed" : run.status === 2 ? "SKIPPED (browser not available)" : "FAILED"]);
}
// A save the app itself refuses (a 501-character title) keeps the typed body in the recovery panel across a reload and another note.
const refused = join(dirname(smoke), "refusedSaveKeepsText.mjs");
for (const engine of ["chromium", "mobile-chrome"]) {
  const run = spawnSync(process.execPath, [refused, engine, ...passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir")], { stdio: "inherit" });
  summary.push([`refused save ${engine}`, run.status === 0 ? "passed" : run.status === 2 ? "SKIPPED (browser not available)" : "FAILED"]);
}
// Back closes the newest surface and leaves the page (backClosesSurfaces.mjs; Chromium and its phone window).
const back = join(dirname(smoke), "backClosesSurfaces.mjs");
for (const engine of ["chromium", "mobile-chrome"]) {
  const run = spawnSync(process.execPath, [back, engine, ...passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir")], { stdio: "inherit" });
  summary.push([`back ${engine}`, run.status === 0 ? "passed" : "FAILED"]);
}
// The note-level view tests that drive the real app after the smoke test (one Chromium run each; they open their own
// desktop and phone windows). The handwriting tab: add it, draw, add a page, type in 內容, reload, take the tab away and add it back.
// Chromium is the engine they use: where smoke.mjs could not start it they are skipped too, never failed for it.
// A link to a task that is no note's line opens the task's sheet (desktop and phone window).
for (const engine of ["chromium", "mobile-chrome"]) {
  const run = spawnSync(process.execPath, [join(dirname(smoke), "standaloneTaskLink.mjs"), engine, ...passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir")], { stdio: "inherit" });
  summary.push([`task link ${engine}`, run.status === 0 ? "passed" : "FAILED"]);
}
const chromiumRan = !summary.some(([engine, result]) => engine === "chromium" && result.startsWith("SKIPPED"));
for (const script of chromiumRan ? ["handwritingTab.mjs"] : []) {
  const run = spawnSync(process.execPath, [join(dirname(smoke), script), ...passthrough], { stdio: "inherit" });
  summary.push([script.replace(/\.mjs$/, ""), run.status === 0 ? "passed" : "FAILED"]);
}
// The feature scripts that were written one at a time and listed by no runner (2026-11-14 audit: they could rot
// unseen). Each is one Chromium run, with the window its usage line names; all pass against dist-browser today.
// Left out on purpose, because they fail against today's UI (see the PR that added this list): paragraphs.mjs
// (the 「收回原文」 request now needs child_id), phoneViewTabs.mjs (the board's title sheet no longer switches back to
// 內容), timelineDrag.mjs (the timeline page was reworked with Today). measure.mjs, profileWorker.mjs and
// saveUnderWrites.mjs measure and take no pass/fail; touchHold.mjs and the slide scripts have their own npm scripts.
const FEATURES = [
  ["boardMotion.mjs"], ["boardPhoneFull.mjs"], ["caretClearOfBar.mjs"], ["endRoomNoJump.mjs"], ["handwritingFillsHeight.mjs"], ["keyboardScrollNoJitter.mjs"],
  ["listBackNoJump.mjs", "mobile-chrome"], ["partLinks.mjs"], ["phoneBackList.mjs"], ["scrollJitter.mjs"],
  ["sidebarSpringOpen.mjs"], ["textStylePopover.mjs"], ["todayPage.mjs"], ["touchFocusCaret.mjs"], ["touchSelection.mjs"],
];
const dirArgs = passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir");
for (const [script, ...args] of chromiumRan ? FEATURES : []) {
  // --dir is passed only to the scripts that read it (the others take an engine as their first argument)
  const takesDir = readFileSync(join(dirname(smoke), script), "utf8").includes('"--dir"');
  const run = spawnSync(process.execPath, [join(dirname(smoke), script), ...args, ...(takesDir ? dirArgs : [])], { stdio: "inherit" });
  summary.push([script.replace(/\.mjs$/, ""), run.status === 0 ? "passed" : "FAILED"]);
}
console.log("\n" + summary.map(([engine, result]) => `${engine.padEnd(14)} ${result}`).join("\n"));
process.exit(summary.some(([, result]) => result === "FAILED") ? 1 : 0);
