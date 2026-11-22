// Report → machine-readable summary, and the comparison of two reports: the census's half of "the count must not grow"
// for the things a static scan cannot see (computed values: em, calc(), inherited sizes, editor-injected styles). The guards
// (src/test/guards/allowlist) hold the written values; this holds what ends up on screen.
//   node e2e/style-census/run.mjs --compare <older report.json> [--against <newer report.json>]
// With --against it only compares two files (no browser, instant). Without it, it runs the census (about 19 minutes, needs
// `npm run build:browser`) and compares the result with the older report. NOT wired into CI: it needs a browser and the time.

/** `{ scope, kinds: { kind: { total, off, offDistinct } } }` from a report; `scope` says what was measured, so two summaries can be checked for being comparable. */
export function summarize(report) {
  return {
    date: report.date,
    scope: { combos: [...report.combos].sort(), screens: Object.keys(report.byScreen).sort() },
    kinds: Object.fromEntries(Object.entries(report.kinds).map(([kind, k]) => [kind, { total: k.total, off: k.off, offDistinct: k.offDistinct }])),
  };
}

/**
 * Compare `newer` with `older`. Only screens measured in both are compared (a screen that errored in one run must not look like
 * an improvement or a regression), and the width × theme combinations must be the same.
 * @returns {{ ok: boolean, comparable: boolean, rows: { kind: string, before: number, after: number, grew: boolean }[], notes: string[] }}
 */
export function compareReports(older, newer) {
  const notes = [];
  const a = [...older.combos].sort().join(","), b = [...newer.combos].sort().join(",");
  if (a !== b) return { ok: false, comparable: false, rows: [], notes: [`兩份報告量的寬度×主題不同（${a} ／ ${b}），不能比`] };
  const common = Object.keys(older.byScreen).filter((s) => s in newer.byScreen);
  const missing = Object.keys(older.byScreen).filter((s) => !(s in newer.byScreen));
  if (missing.length) notes.push(`新報告沒量到、不比較的畫面：${missing.join("、")}`);
  if (!common.length) return { ok: false, comparable: false, rows: [], notes: [...notes, "兩份報告沒有共同的畫面"] };
  const kinds = [...new Set([...Object.keys(older.kinds), ...Object.keys(newer.kinds)])];
  const offOf = (report, kind) => common.reduce((sum, s) => sum + (report.byScreen[s]?.[kind]?.off ?? 0), 0);
  const rows = kinds.map((kind) => {
    const before = offOf(older, kind), after = offOf(newer, kind);
    return { kind, before, after, grew: after > before };
  });
  return { ok: rows.every((r) => !r.grew), comparable: true, rows, notes };
}

export function renderComparison(result) {
  if (!result.comparable) return result.notes.join("\n");
  const lines = result.rows.map((r) => `${r.grew ? "FAIL" : "ok  "}  ${r.kind}：不在刻度上 ${r.before} → ${r.after}${r.grew ? "（變多了）" : ""}`);
  return [...result.notes, ...lines].join("\n");
}
