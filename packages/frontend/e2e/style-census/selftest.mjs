// The census's own test: a fake page with known values must be measured as expected, the scale must classify them,
// and every kind in scale.mjs must have a row in docs/agents/appearance-rules.md (so the document and the tool cannot drift apart).
// node e2e/style-census/selftest.mjs      (needs no build)
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../layout-audit/env.mjs";
import { INPAGE_SOURCE } from "../layout-audit/inpage.mjs";
import { CENSUS_SOURCE } from "./collect.mjs";
import { KINDS, classify } from "./scale.mjs";
import { compareReports, summarize } from "./compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

// The comparison of two reports (no browser): a grown off-scale count fails, a shrunk one passes, different scopes cannot be compared.
const report = (off, combos = ["390__light"], screens = { a: off, b: 5 }) => ({
  date: "2026-11-17", combos,
  byScreen: Object.fromEntries(Object.entries(screens).map(([s, n]) => [s, { spacing: { total: 100, off: n }, opacity: { total: 10, off: 1 } }])),
  kinds: { spacing: { total: 200, off: 0, offDistinct: 0 }, opacity: { total: 20, off: 2, offDistinct: 1 } },
});
check("a grown off-scale count fails the comparison", !compareReports(report(10), report(11)).ok);
check("an equal or smaller one passes", compareReports(report(10), report(10)).ok && compareReports(report(10), report(3)).ok);
check("different width × theme sets are not comparable", !compareReports(report(10), report(10, ["1440__light"])).comparable);
check("only screens measured in both are compared", compareReports(report(10), report(10, ["390__light"], { a: 10 })).ok);
check("the summary says what was measured", summarize(report(10)).scope.screens.join() === "a,b" && summarize(report(10)).kinds.opacity.off === 2);

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.setContent(`<style>
  :root { --ac-ink: rgb(10, 20, 30); }
  .t { font-size: 17px; font-weight: 500; line-height: 1.7; padding: 6px 10px; color: var(--ac-ink); }
  .b { border: 1px solid rgb(200,200,200); border-radius: 6px; height: 34px; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
</style><p class="t">字</p><button class="b">按鈕</button><svg width="15" height="15" stroke="black" stroke-width="2"><circle r="3"/></svg>`);
await page.evaluate(INPAGE_SOURCE); await page.evaluate(CENSUS_SOURCE);
const data = await page.evaluate(() => window.__census.collect({ colourPriority: [] }));
const has = (kind, value) => !!data.values[kind]?.[value];
check("font size is measured", has("font-size", "17px"));
check("a weight of 500 is measured", has("font-weight", "500"));
check("line height is a ratio to the font size", has("line-height", "1.7"));
check("padding is measured per side", has("spacing", "6px") && has("spacing", "10px"));
check("a framed button is found", has("border-where", "off:按鈕外面一圈框"));
check("radius 6px is measured", has("radius", "6px"));
check("an untokened shadow is raw", Object.keys(data.values.shadow ?? {}).some((v) => v.startsWith("raw:")));
check("icon size and stroke are measured", has("icon-size", "15px") && has("icon-stroke", "2"));
check("control height is measured", has("control-height", "34px"));
check("17px is off the font scale, 16px is on", !classify("font-size", "17px").on && classify("font-size", "16px").on);
check("6px is off the spacing scale, 8px is on", !classify("spacing", "6px").on && classify("spacing", "8px").on);
check("a touch screen wants 44, a mouse 28 or 32", classify("control-height", "44px", { coarse: true }).on && !classify("control-height", "44px", { coarse: false }).on && classify("control-height", "32px", { coarse: false }).on);
check("a button with a frame is off", !classify("border-where", "off:按鈕外面一圈框").on);
await browser.close();

const doc = readFileSync(resolve(here, "../../../../docs/agents/appearance-rules.md"), "utf8");
for (const k of KINDS) check(`rules document has a row for 「${k.label}」 (${k.id})`, doc.includes(`\`${k.id}\``));
for (const k of KINDS) for (const rule of k.guard?.match(/fe-[\w-]+/g) ?? []) check(`rules document names the rule ${rule} of 「${k.label}」`, doc.includes(`\`${rule}\``));
process.exit(failed ? 1 : 0);
