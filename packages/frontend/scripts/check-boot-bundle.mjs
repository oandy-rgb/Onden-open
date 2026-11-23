// After a build: the JS the app loads for sure after sign-in (the page entry,
// AppRoot and the workspace chunk, with everything they import statically)
// must stay within a gzip budget, and no module directory (src/modules/<id>/)
// may bring more than its own cap into it. Written by scripts/bootReportPlugin.mjs
// into dist/boot-report.json; this runs in `npm run build` after the worker check.
//
//   node scripts/check-boot-bundle.mjs            dist/boot-report.json
//   node scripts/check-boot-bundle.mjs <file>     another report (for testing the check)
//
// A module's entry (modules/<id>/index) is registration data only: id, name,
// icon, commands, the small "in use?" function. Screens, editors, dialogs,
// settings widgets and big libraries load on use with lazyWithReload (see
// modules/tasks, modules/rss). If a module goes over its cap, move what it
// imports at the top of its index into lazyWithReload(() => import(...)).
// If a size grew on purpose, raise the number here, in the same PR, and say why.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

// gzip bytes. Measured 2026-10-30 once the modules loaded their screens on
// use: the boot JS was 480,248 B (it was 524,697 B before), of which the
// modules' directories were 11.1 KB (40.3 KB before). Each limit below is the
// measured size plus a margin of about 5% (total) or 50% (one module).
// Raised to 512,000 on 2026-10-30 (measured 508,600 B): the day timeline (#979)
// registers each module's dayItems on its entry, due-soon reminders (#987) run
// while the app is open, and their strings; the 「接下來」 tag itself loads on use.
// Lowered to 500,000 on 2026-10-31 (measured 475,900 B): one enum value imported
// from @xyflow/react had put the whole board library and d3 (37 KB) into it.
// Lowered to 443,000 on 2026-11-01 (measured 433,044 B, 487.7 KiB before): the zh-TW
// dictionary is split in two and only the half the boot screens use is in the boot JS
// (lib/i18n.zh-TW.boot.ts; the rest loads after boot). The budget is the measured size
// plus about 10 KiB, and only goes down: new features load on use by default.
// Lowered to 430,700 on 2026-11-02 (measured 425,593 B after perf/boot-slim-2, #1207):
// the owner's rule is the measured size plus 5 KiB. Every build prints how far it is
// from BOOT_MEASURED_GZIP; a PR that adds more than +1 KiB says why in its description,
// and when less than about 1.5 KiB of room is left, the next slimming round is due
// before anything hits the limit.
// Lowered to 392,028 on 2026-11-02 (measured 386,908 B after perf/boot-slim-3): the ⌘K palette's
// engine, the create sheet, saved-view layouts and the 「這次更新」 list load on use.
// Lowered to 377,434 on 2026-11-02 (measured 372,314 B after perf/boot-slim-4, 391,318 B before): the excerpt
// expansion of note export (it needs the markdown parser), note templates and example notes, the citations
// commands, and the tag-delete/tag-move/move-to-space/shortcuts/time-zone dialogs load on use (components/lateShell.ts),
// and 42 zh-TW strings only late screens use moved to the late half.
//
// Lowered to 337_206 on 2026-11-11 (measured 332_086 B after perf/boot-slim-4 round 2, 377_247 B before): the Markdown
// parser (unified, micromark, mdast-util-from-markdown, vfile: about 45 KiB) was in the boot JS because two
// pure helpers, plainExcerpt and hasLinkPath, lived in modules that import the parser (linkContext, blockLink);
// they now live in leaf modules (graphemes, text). The parser packages are in FORBIDDEN_BOOT_PACKAGES now.
//
// Lowered to 330_839 on 2026-11-12 (measured 325_719 B after perf/boot-slim-5, about 334_300 B before): 87 zh-TW strings no
// boot code uses went to the late half, the sign-in form (LoginForm) loads only when nobody is signed in, and
// the Markdown pipeline's remark-wiki-link plugin left the boot JS (the package entry holds no third-party imports).
//
// Lowered to 320_787 on 2026-11-13 (measured 315_667 B after perf/boot-slim-6, 321.3 KiB before; main had grown
// 3.2 KiB since the round-5 figure above): a module shared by boot code and a screen that loads on use is placed
// in a boot chunk with everything the screen needs from it, so each fix moved the small piece boot reads into a
// leaf, or loaded the one user on use. tagMembersResolver left lib/basesEval for lib/nodeTags (-1.3 KiB, search had
// pulled the bases evaluator); the shape-kind list moved to sharedContract and ink.ts no longer calls a function at
// load (-2.2); the typo-tolerant search loads snippetAround with Fuse (-1.5); the skills header button and the JSON
// Canvas parser load on use (-6.2); the embeds remark plugin got its own file, away from unist-util-visit (-0.8).
//
// Lowered to 310_204 on 2026-11-15 (measured 305_084 B after perf/boot-js-slim-2026-11-15, 311.4 KiB before; the budget
// was 313.3 KiB and the next batches would have been refused): 87 zh-TW strings no boot code uses went to the late half
// (the build now fails if the boot half holds one: bootReportPlugin bootKeysUnused), and the 200 rarer server error
// codes with their zh-TW wording (backup restore, AI helpers and keys, spaces, invites…) load on first use with
// serverSentences.ts, which readErrorBody already fetched before an ApiError is built (-11.3 KiB together).
//
// Slimming round 2026-11-20 (perf/boot-js-slim-2026-11-20): measured 306_265 B, 310_018 B before (-3.7 KiB). Note export
// (lib/noteExport) is fetched on the first export, the 「移動…」 list (ParentPicker) and the tag list's tidy line (TagTidy)
// load when shown (components/lateShell.ts), and the 21 zh-TW strings only they use went to the late half. The owner's
// rule would set the budget to measured + 5 KiB (311_385); that is higher than today's, and this round fell short of
// its 8 KiB goal, so the budget stays at 310_204 (3.8 KiB of room) instead of being raised.
//
// Slimming round 2026-11-22 (perf/boot-slim-4): measured 307_494 B, 309_598 B before (-2.1 KiB; well short of the 8 KiB goal:
// what is left in the boot JS is the data layer, React and screens that are on the first page; see the PR description). The
// writes that only run after a server answer (version history, part-to-child, part links) are made on their first call
// (lib/data/loadedOnFirstUse.ts, onlineWriters.ts), the split view's divider and quote button load with the second side,
// and the server-setup and invite-claim screens load on use. measured + 5 KiB (312_614) would be higher than today's
// budget, so it stays at 310_204 (2.6 KiB of room) instead of being raised.
//
// Slimming round 2026-11-22 (perf/boot-slim-5-board): measured 300_345 B, about 309_650 B before (302.4 KiB; -9.1 KiB). The board's hooks
// (useBoardWorkspace, useGraphLayout, useCanvasActions, useBoardTree and the layout and card code only they use) now run in
// components/BoardController, loaded right after the first paint together with the board screen; boot code keeps only the
// small store lib/boardController. measured + 5 KiB (305_465) is lower than today's budget, so the budget stays at 310_204
// (it is not raised, and now has 9.6 KiB of room).
export const BOOT_BUDGET_GZIP = 310_204;
// The boot JS of main when the budget was last set. Update it with the budget, or when
// a merge moves the boot JS by more than 1 KiB, so the delta below stays meaningful.
export const BOOT_MEASURED_GZIP = 300_345;
/** Growth over this much (bytes, gzip) needs a reason in the PR description. */
export const BOOT_GROWTH_NOTE = 1_024;
// Libraries only a screen needs, which must never be in the boot JS: a value
// imported from one of them, even a constant, brings the whole library along.
// Import its types only (`import type`), or load the screen on use.
export const FORBIDDEN_BOOT_PACKAGES = [/^@xyflow\//, /^d3-/, /^(unified|micromark|mdast-util-from-markdown|remark-parse|vfile)$/];
// What one module directory (src/modules/<id>/) may bring into the boot JS, gzip,
// estimated from each file's share of its chunk. A module not listed gets the
// default, so a new module cannot bring a screen in without this check noticing.
export const DEFAULT_MODULE_CAP_GZIP = 1_500;
/** @type {Record<string, number>} */
export const MODULE_CAP_GZIP = {
  // Logic the shell reads at boot (the home line, card extraction, the nav mark):
  review: 3_000,
  rss: 2_800,
};

/** Problems with one boot report, as sentences that say what to do. */
export function checkBootReport(report, { total = BOOT_BUDGET_GZIP, caps = MODULE_CAP_GZIP, fallbackCap = DEFAULT_MODULE_CAP_GZIP } = {}) {
  const problems = [];
  for (const [id, row] of Object.entries(report.modules)) {
    if (id === "core") continue;
    const cap = caps[id] ?? fallbackCap;
    if (row.gzip > cap) {
      problems.push(`module "${id}" brings ${kb(row.gzip)} gzip into the boot JS, over its cap of ${kb(cap)}: ` +
        `keep src/modules/${id}/index to registration data and load its screens, dialogs, settings widgets and libraries on use ` +
        `(lazyWithReload(() => import("./Screen")), like modules/tasks and modules/rss)`);
    }
  }
  const forbidden = (report.packages ?? []).filter((name) => FORBIDDEN_BOOT_PACKAGES.some((rule) => rule.test(name)));
  if (forbidden.length) {
    problems.push(`the boot JS holds ${forbidden.join(", ")}, which only the board needs: ` +
      `import its types with \`import type\` (write an enum's value as its string) or load the screen on use`);
  }
  if (report.gzipTotal > total) {
    const biggest = Object.entries(report.modules).filter(([id]) => id !== "core").sort((a, b) => b[1].gzip - a[1].gzip).slice(0, 3)
      .map(([id, row]) => `${id} ${kb(row.gzip)}`).join(", ");
    problems.push(`the boot JS is ${kb(report.gzipTotal)} gzip, over its budget of ${kb(total)} ` +
      `(largest module shares: ${biggest}); find what the entry imports statically and load it on use`);
  }
  return problems;
}

/** How far this build is from the recorded main size and from the budget, in words. */
export function bootDeltaLine(gzipTotal, { measured = BOOT_MEASURED_GZIP, budget = BOOT_BUDGET_GZIP, note = BOOT_GROWTH_NOTE } = {}) {
  const delta = gzipTotal - measured;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
  const room = budget - gzipTotal;
  let line = `boot JS vs main (${kb(measured)}): ${sign}${kb(Math.abs(delta))}; room left ${kb(room)}`;
  if (delta > note) line += ` — over +${kb(note)}: say why in the PR description`;
  if (room < 1_536) line += " — under 1.5 KiB of room: the next slimming round is due";
  return line;
}

function main() {
  const file = process.argv[2] ?? fileURLToPath(new URL("../dist/boot-report.json", import.meta.url));
  let report;
  try { report = JSON.parse(readFileSync(file, "utf8")); } catch {
    console.error(`check-boot-bundle: FAILED\n  - cannot read ${file} (did the build run? is scripts/bootReportPlugin.mjs still in astro.config.mjs?)`);
    process.exit(1);
  }
  const moduleGzip = Object.entries(report.modules).filter(([id]) => id !== "core").reduce((n, [, row]) => n + row.gzip, 0);
  console.log(`boot JS: ${report.chunks.length} files, ${kb(report.rawTotal)} raw, ${kb(report.gzipTotal)} gzip (budget ${kb(BOOT_BUDGET_GZIP)}); modules ${kb(moduleGzip)} of it`);
  console.log(bootDeltaLine(report.gzipTotal));
  const problems = checkBootReport(report);
  if (problems.length) {
    console.error("\ncheck-boot-bundle: FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
