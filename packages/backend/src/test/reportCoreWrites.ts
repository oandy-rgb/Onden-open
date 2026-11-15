// Report-only (vitest setupFile). With ONDEN_REPORT_CORE_WRITES=<file>, appends
// one line per core-table write that ran inside a plain withTransaction()
// (no event lock taken: not mutate()/withEventTransaction()) and was reached
// from product code. Fixtures (seedQ, test files) are left out. Nothing fails.
import { appendFileSync } from "node:fs";

const out = process.env.ONDEN_REPORT_CORE_WRITES;
// Loaded only when reporting: a setup file that imports db.js always would cache
// the real modules before a test file's vi.mock() can replace them.
if (out) {
  const { observeCoreWritesWithoutEventLock } = await import("../db.js");
  observeCoreWritesWithoutEventLock((table) => {
    Error.stackTraceLimit = 60; // the default 10 ends inside the transaction wrappers
    const frames = (new Error().stack ?? "").split("\n").slice(2).map((l) => l.trim())
      .filter((l) => !/\/src\/db\.ts|node_modules|node:internal/.test(l));
    const caller = frames.find((l) => !/\/src\/test\//.test(l)) ?? "";
    if (!caller || (frames[0] && /\/src\/test\//.test(frames[0]))) return;
    const here = caller.replace(/^at /, "").replace(/.*\/src\//, "");
    // The first product frame above the helper's own file: who in product code called it ("-" = a test did).
    const file = (l: string) => l.replace(/^at /, "").replace(/.*\/src\//, "").replace(/:\d+:\d+\)?$/, "");
    const above = frames.find((l) => !/\/src\/test\//.test(l) && file(l) !== file(caller) && !/spine\/txHooks|requestContext/.test(l) && /\/src\//.test(l));
    const viaTest = !above && frames.some((l) => /\/src\/test\//.test(l));
    appendFileSync(out, `${table} ${here} <- ${above ? file(above) : viaTest ? "(test)" : "?"}\n`);
  });
}
