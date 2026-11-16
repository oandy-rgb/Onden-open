// The entry of the merge core for code outside this folder (lint `module-entry`). It lists ONLY what a product caller uses today:
// the database write-back, which spine/stampedImport.ts `mergeUnitsIntoWorkspace` calls. Everything else in the folder (rules/, body.ts, store.ts,
// the rest of unit.ts) has no product caller yet and is registered in scripts/unused-code-baseline.json `intentional`, with a reason and an expiry:
// do NOT add a name here to make unused:check pass; add the caller.
export type { IncomingUnit, UnitMergeReport } from "./dbUnits.js";
export { storeMergedUnits } from "./dbUnits.js";
export type { SkewGate } from "./unit.js";
