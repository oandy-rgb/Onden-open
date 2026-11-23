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
const passthrough = process.argv.slice(2).filter((arg) => arg !== "--require-engines");
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
// A note whose pages are listed in note_pages (blank pages and the pages of a PDF): shown in order, drawn on, kept across a reload; the notes made before look as they did.
const pages = join(dirname(smoke), "notePages.mjs");
for (const engine of ["chromium", "mobile-chrome"]) {
  const run = spawnSync(process.execPath, [pages, engine, ...passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir")], { stdio: "inherit" });
  summary.push([`note pages ${engine}`, run.status === 0 ? "passed" : "FAILED"]);
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
// Taking my notes to another device through one file: two fresh browser copies, a 2,000-note file, a page killed half way (addDeviceFile.mjs).
for (const engine of ["chromium", "mobile-chrome"]) {
  const run = spawnSync(process.execPath, [join(dirname(smoke), "addDeviceFile.mjs"), engine, ...passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir")], { stdio: "inherit" });
  summary.push([`add device ${engine}`, run.status === 0 ? "passed" : run.status === 2 ? "SKIPPED (browser not available)" : "FAILED"]);
}
const chromiumRan = !summary.some(([engine, result]) => engine === "chromium" && result.startsWith("SKIPPED"));
for (const script of chromiumRan ? ["handwritingTab.mjs"] : []) {
  const run = spawnSync(process.execPath, [join(dirname(smoke), script), ...passthrough], { stdio: "inherit" });
  summary.push([script.replace(/\.mjs$/, ""), run.status === 0 ? "passed" : "FAILED"]);
}
// The feature scripts that were written one at a time and listed by no runner (2026-11-14 audit: they could rot
// unseen). Each is one Chromium run, with the window its usage line names; all pass against dist-browser today.
// Left out on purpose, because they fail against today's UI (checked again 2026-11-22; named with the reason in
// scripts/ci-reach-baseline.json): paragraphs.mjs (the 「收回原文」 request now needs child_id), timelineDrag.mjs (the
// timeline page was reworked with Today). measure.mjs, profileWorker.mjs and saveUnderWrites.mjs measure and take no
// pass/fail; touchHold.mjs and the slide scripts have their own npm scripts. The last row (bigInk … phoneViewTabs) was
// listed by no runner until 2026-11-22; each passed against dist-browser that day.
const FEATURES = [
  ["boardMotion.mjs"], ["boardPhoneFull.mjs"], ["caretClearOfBar.mjs"], ["deleteLineTask.mjs"], ["caretClearOfBar.mjs", "tablet"], ["caretKeyboardMatrix.mjs"], ["caretClearOfBar.mjs", "ios"], ["typeAtTheEnd.mjs"], ["tapBelowLastLine.mjs"], ["shortTypingLayout.mjs", "tablet"], ["shortTypingLayout.mjs", "mobile-chrome"], ["endRoomNoJump.mjs"], ["expandedPaneFillsWindow.mjs"], ["expandedPaneFillsWindow.mjs", "mobile-chrome"],
  ["handwritingFillsHeight.mjs"], ["keyboardScrollNoJitter.mjs"],
  ["listBackNoJump.mjs", "mobile-chrome"], ["partLinks.mjs"], ["pdfNoteText.mjs"], ["phoneBackList.mjs"], ["scrollJitter.mjs"],
  ["sidebarSpringOpen.mjs"], ["textStylePopover.mjs"], ["touchFocusCaret.mjs"], ["touchSelection.mjs"],
  ["bigInk.mjs"], ["contentTabRemovable.mjs"], ["phoneAiPanel.mjs"], ["reviewCardFront.mjs"], ["reviewGroups.mjs"], ["splitNoteWraps.mjs"], ["phoneViewTabs.mjs"], ["tabletViews.mjs"],
  // The local edition has no sign-out and no membership gate, even with a check that never finishes (2026-11-23 owner report).
  ["localEditionNoGate.mjs"], ["localEditionNoGate.mjs", "mobile-chrome"],
];
const dirArgs = passthrough.filter((arg, i, all) => arg === "--dir" || all[i - 1] === "--dir");
for (const [script, ...args] of chromiumRan ? FEATURES : []) {
  // --dir is passed only to the scripts that read it (the others take an engine as their first argument)
  const takesDir = readFileSync(join(dirname(smoke), script), "utf8").includes('"--dir"');
  const run = spawnSync(process.execPath, [join(dirname(smoke), script), ...args, ...(takesDir ? dirArgs : [])], { stdio: "inherit" });
  summary.push([[script.replace(/\.mjs$/, ""), ...args].join(" "), run.status === 0 ? "passed" : "FAILED"]);
}
// A student's day as ONE continuous session (dayWalk.mjs; steps in walk/steps.mjs): desktop 1280×800 and the tablet profile
// (layout-audit/env.mjs PROFILES "tablet-landscape": 1280×800, 2 device pixels, touch). Needs Chromium like the feature scripts.
// The third run serves the folder from a sub-path (as a preview address does): the PDF worker once asked for the host's root.
for (const [profile, ...extra] of chromiumRan ? [["1280"], ["tablet-landscape"], ["1280", "--prefix", "/onden/"]] : []) {
  const run = spawnSync(process.execPath, [join(dirname(smoke), "dayWalk.mjs"), profile, ...extra, ...dirArgs], { stdio: "inherit" });
  summary.push([`dayWalk ${profile}${extra.length ? ` ${extra.join(" ")}` : ""}`, run.status === 0 ? "passed" : "FAILED"]);
}
console.log("\n" + summary.map(([engine, result]) => `${engine.padEnd(14)} ${result}`).join("\n"));
// --require-engines (the scheduled CI job): a SKIPPED engine fails too, so a runner without the browsers is not a green night.
const requireEngines = process.argv.includes("--require-engines");
process.exit(summary.some(([, result]) => result === "FAILED" || (requireEngines && result.startsWith("SKIPPED"))) ? 1 : 0);
