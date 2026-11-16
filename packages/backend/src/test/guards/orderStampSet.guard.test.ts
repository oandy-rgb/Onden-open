// Migration 204 defines order_stamp_set again (migration 200 made it) with one line added: while a snapshot is being imported, a row keeps
// the order_stamp it carries. The rest must stay 200's body, word for word: change both, or this fails. Pure file check, no database.
// Found 2026-11-16: with 200 on main, an imported row got the importing transaction's stamp as its order_stamp and the two databases'
// digests of content_nodes and note_pointers differed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../db");
const bodyOf = (file: string, last = false) => {
  const text = readFileSync(join(dir, file), "utf8");
  const head = "CREATE OR REPLACE FUNCTION order_stamp_set() RETURNS trigger AS $$";
  const start = last ? text.lastIndexOf(head) : text.indexOf(head);
  return text.slice(start, text.indexOf("$$ LANGUAGE plpgsql;", start)).replace(/\s+/g, " ");
};
const ADDED = "IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF; ";

describe("order_stamp_set in migration 204 is migration 200's, plus the one line", () => {
  it("is the same body once the added line is taken out", () => {
    const later = bodyOf("migrations/204_stamped_snapshot_join.sql");
    expect(later).toContain(ADDED);
    expect(later.replace(ADDED, "")).toBe(bodyOf("migrations/200_order_keys.sql"));
  });
  it("the snapshot of the schema (db/schema.sql) ends with migration 204's body", () => {
    expect(bodyOf("schema.sql", true)).toBe(bodyOf("migrations/204_stamped_snapshot_join.sql"));
  });
});
