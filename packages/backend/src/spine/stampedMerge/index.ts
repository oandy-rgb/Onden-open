// The entry of the merge core for code outside this folder (lint `module-entry`). It lists ONLY what a product caller uses today:
// the database write-back (units and rows), which spine/stampedImport.ts `mergeUnitsIntoWorkspace` and `applyChangeBundle` call. Everything else in the folder (rules/, body.ts, store.ts,
// the rest of unit.ts) has no product caller yet and is registered in scripts/unused-code-baseline.json `intentional`, with a reason and an expiry:
// do NOT add a name here to make unused:check pass; add the caller.
export type { IncomingUnit, UnitMergeReport } from "./dbUnits.js";
export { storeMergedUnits, UNIT_SOURCES, CARRIED_LABELS, labelsOf, rowMatchOf, unitTextsSql } from "./dbUnits.js";
export type { RowsReport } from "./dbRows.js";
export { storeMergedRows } from "./dbRows.js";
export type { SkewGate } from "./unit.js";
export { GENESIS_STAMP_ORIGIN } from "./unit.js";
