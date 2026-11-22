// The tap-target ratchet: on a touch screen (pointer: coarse) how many controls on a screen have a hit area under 44×44 CSS px.
// The number may only go down. Baseline: scripts/tap-target-baseline.json = { "<size>": { "<screen>": { total, off } } };
// `total` is only information (what was measured); `off` is the number that must not grow. Manual like the rest of the census
// (it needs a browser); the baseline file itself is under `npm run ratchet:check` (scripts/*baseline*.json: no number may rise).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TAP_BASELINE_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/tap-target-baseline.json");

export function readTapBaseline(file = TAP_BASELINE_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/** `measured` has the shape of the baseline. Only screens in both are compared; a screen that did not open must not look like an improvement. */
export function compareTaps(base, measured) {
  const rows = [];
  for (const [size, screens] of Object.entries(measured)) for (const [screen, m] of Object.entries(screens)) {
    const b = base[size]?.[screen];
    rows.push({ size, screen, before: b ? b.off : null, after: m.off, total: m.total, grew: b ? m.off > b.off : false });
  }
  return { ok: rows.every((r) => !r.grew), rows };
}

export function renderTapComparison(r) {
  const lines = r.rows.map((x) => `${x.grew ? "FAIL" : "ok  "}  ${x.size} ${x.screen}：不到 44 的控制項 ${x.before ?? "（基準沒有）"} → ${x.after}／${x.total}${x.grew ? "（變多了）" : ""}`);
  return lines.join("\n") || "沒有量到任何觸控畫面（這個寬度不是觸控螢幕？）";
}

/** Lower or add; never raise (a raised number is a regression, not a new baseline). Returns the counts. */
export function writeTapBaseline(base, measured, file = TAP_BASELINE_FILE) {
  const out = JSON.parse(JSON.stringify(base));
  const n = { lowered: 0, added: 0, kept: 0 };
  for (const [size, screens] of Object.entries(measured)) for (const [screen, m] of Object.entries(screens)) {
    const cur = out[size]?.[screen];
    if (!cur) { (out[size] ||= {})[screen] = { total: m.total, off: m.off }; n.added++; }
    else if (m.off < cur.off) { out[size][screen] = { total: m.total, off: m.off }; n.lowered++; }
    else n.kept++;
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, Object.fromEntries(Object.keys(out[k]).sort().map((s) => [s, out[k][s]]))]));
  writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
  return n;
}
