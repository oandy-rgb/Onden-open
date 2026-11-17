// Same-level order has one set of writers (migration 200, docs/architecture/proposals/distributed-ready-2026-11-12.md §4.7).
// A row's place among its siblings is a key made between its neighbours' keys (@onden/markdown keyBetween) — never a number
// picked by the caller. Any code that writes order_key must get the key from services/orderKeys.ts or @onden/markdown, and
// nothing writes the frozen integer `sort_order` at all. A new writer fails here until it uses the helper (or is listed with
// the reason it may not).

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

/** A statement that writes order_key: an INSERT naming the column, or an assignment to it (`SET order_key =`, `set("order_key"`,
 *  the restore's field loop names it in nodeScalarFields, the one row write of a save in NODE_COLUMNS). */
const WRITES_ORDER_KEY = /INSERT INTO (?:content_nodes|note_pointers)\s*\(?[^;`]*\border_key\b|\bSET\b[^;`]*\border_key\s*=|\bset\("order_key"|(?:nodeScalarFields|NODE_COLUMNS) = \[[^\]]*"order_key"/is;
/** A statement that writes the frozen integer. */
const WRITES_SORT_ORDER = /INSERT INTO (?:content_nodes|note_pointers)\s*\(?[^;`]*\bsort_order\b|\bSET\b[^;`]*\bsort_order\s*=/is;
/** Where a key comes from. */
const USES_HELPER = /\b(?:appendOrderKey|assertOrderKey|keyForRestore|translateLegacySortOrder|respaceSiblings|respaceIfTooLong|keyBetween|keysBetween|evenOrderKeys)\b/;

// ratchet:list ORDER_KEY_WRITERS
/** Files that write order_key, each with the helper it gets the key from (checked below) and why it writes. */
const WRITERS: Record<string, string> = {
  "services/orderKeys.ts": "the owner: respace, append, translate, restore",
  "services/noteCreate.ts": "a new note: the caller's key, an older client's integer translated, or last",
  "services/nodeUpdate.ts": "an edit or move: the caller's key, translated, or last under a new parent",
  "services/pointers.ts": "a new pointer: the caller's key, translated, or last",
  "services/noteDuplicate.ts": "a copy goes last among its siblings",
  "services/templateExpander.ts": "template slots become children in order, each last",
  "services/eventRestore/restore.ts": "undo of a move: the earlier key, or a fresh one between its old neighbours",
};

/** Files that write a column of the same name that is not a sibling order. */
const UNRELATED: Record<string, string> = {
  "services/actorPrefs.ts": "actor_prefs.order_key is the position of a preference in a list, a number of its own table",
};

describe("order keys are written in one way", () => {
  it("only the listed files write order_key", () => {
    const writers = files.filter((f) => !(f.file in UNRELATED) && WRITES_ORDER_KEY.test(f.text)).map((f) => f.file).sort();
    expect(writers, "a new writer of order_key: take its key from services/orderKeys.ts (appendOrderKey, assertOrderKey, translateLegacySortOrder) or @onden/markdown keyBetween, then list it here with the reason").toEqual(Object.keys(WRITERS).sort());
  });

  it("each of them gets its key from the helper", () => {
    for (const file of Object.keys(WRITERS)) {
      expect(USES_HELPER.test(files.find((f) => f.file === file)!.text), `${file} writes order_key without the shared helper`).toBe(true);
    }
  });

  it("nothing writes the frozen integer sort_order, except the tool that takes migration 200 out of a test copy", () => {
    expect(files.filter((f) => WRITES_SORT_ORDER.test(f.text) && f.file !== "browser/makeOldCopy.ts").map((f) => f.file)).toEqual([]);
  });

  it("the pattern catches the writes it is meant to", () => {
    expect(WRITES_ORDER_KEY.test("INSERT INTO content_nodes (id, order_key) VALUES ($1, $2)")).toBe(true);
    expect(WRITES_ORDER_KEY.test("UPDATE note_pointers SET order_key = $3 WHERE id = $1")).toBe(true);
    expect(WRITES_ORDER_KEY.test('if ("order_key" in x) set("order_key", k)')).toBe(true);
    expect(WRITES_ORDER_KEY.test("SELECT order_key FROM content_nodes ORDER BY order_key")).toBe(false);
    expect(WRITES_SORT_ORDER.test("INSERT INTO content_nodes (id, sort_order) VALUES ($1, 0)")).toBe(true);
    expect(WRITES_SORT_ORDER.test("UPDATE content_nodes SET sort_order = 3")).toBe(true);
  });
});
