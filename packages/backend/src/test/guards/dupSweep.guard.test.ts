// One owner per small job (docs/research/dup-sweep-2026-10-29-backend.md, batch 1).
// Each rule names the file that owns the job; a second copy anywhere else
// fails here, so the duplicate has to be removed or the owner reused.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}
const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

/** Files (other than `owners`) whose source matches `pattern`. */
function outside(pattern: RegExp, owners: string[]): string[] {
  return files.filter((f) => !owners.includes(f.file) && pattern.test(f.text)).map((f) => f.file);
}

describe("one owner per small job", () => {
  it("a writer's patch is turned back into text only by services/patchedValue.ts", () => {
    expect(outside(/\bapplyPatch\(/, ["services/patchedValue.ts"])).toEqual([]);
  });

  it("a patch is made on the server only to answer the offline drawing download", () => {
    expect(outside(/\bmakePatch\(/, ["services/sync/drawings.ts"])).toEqual([]);
  });

  it("SHA-256 hex digests come from utils.ts sha256Hex", () => {
    // base64 digests (CSP hashes) are another format and stay where they are.
    expect(outside(/createHash\("sha256"\)[^;]*\.digest\("hex"\)/s, ["utils.ts"])).toEqual([]);
  });

  it("the per-workspace event-append lock key is defined in spine/eventLock.ts only", () => {
    expect(outside(/event-append:/, ["spine/eventLock.ts"])).toEqual([]);
  });

  it("block ids are minted by services/blockNodes.ts newBlockId", () => {
    expect(outside(/randomBytes\(4\)\.toString\("hex"\)\.slice\(0, 6\)/, ["services/blockNodes.ts"])).toEqual([]);
  });

  it("saved views are ordered by services/tagViews.ts byPinThenName", () => {
    expect(outside(/pin_order \?\? 0\) - \(b\.pin_order/, ["services/tagViews.ts"])).toEqual([]);
  });

  it("'which events are saves' is history/bodyEvents.ts bodyEventSql, not a hand-written predicate", () => {
    expect(outside(/event_type IN \('NODE_CREATED','NODE_UPDATED','NODE_RESTORED'\)/, [])).toEqual([]);
  });

  it("restore refusals history_incomplete / state_conflict are built by eventRestore/refusals.ts", () => {
    const literal = /code: "(?:history_incomplete|state_conflict)", status: 409, (?:force_available: false|detail)/;
    const offenders = files
      .filter((f) => f.file.startsWith("services/eventRestore/") && f.file !== "services/eventRestore/refusals.ts" && literal.test(f.text))
      .map((f) => f.file);
    // restore.ts and attributes.ts still hand-write a few refusals that carry
    // a `reason` or extra fields; they are listed in the sweep report, batch 2.
    expect(offenders.filter((f) => !["services/eventRestore/restore.ts", "services/eventRestore/attributes.ts"].includes(f))).toEqual([]);
  });

  it("bigint ids in event/inbox routes are parsed by routes/params.ts parseBigintId", () => {
    for (const f of ["routes/inbox.ts", "routes/events.ts", "services/eventQuery.ts"]) {
      const text = files.find((x) => x.file === f)!.text;
      // eventQuery.ts keeps one: the `since` cursor, which has its own message and range check.
      const allowed = f === "services/eventQuery.ts" ? 1 : 0;
      expect((text.match(/\/\^\\d\+\$\/\.test\(/g) ?? []).length, f).toBe(allowed);
    }
  });

  it("a new note's personal-or-default space is looked up by services/spaces.ts only", () => {
    expect(outside(/ORDER BY \(kind = 'personal'\) DESC/, ["services/spaces.ts"])).toEqual([]);
    const spaces = files.find((f) => f.file === "services/spaces.ts")!.text;
    expect((spaces.match(/ORDER BY \(kind = 'personal'\) DESC/g) ?? []).length).toBe(1);
  });
});
