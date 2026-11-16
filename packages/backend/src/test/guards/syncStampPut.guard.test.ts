// Migration 204 defines sync_stamp_put again (migration 190 made it) with one line added: stand aside while a snapshot is being imported.
// The rest must stay the statement of 190, word for word, so that a later change of one is not quietly undone by the other: change both, or
// this fails. Pure file check: runs without a database.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../db");
const statementOf = (file: string, last = false) => {
  const text = readFileSync(join(dir, file), "utf8");
  const start = last ? text.lastIndexOf("INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin") : text.indexOf("INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin");
  const end = text.indexOf("deleted = EXCLUDED.deleted;", start) + "deleted = EXCLUDED.deleted;".length;
  return text.slice(start, end).replace(/\s+/g, " ");
};

describe("sync_stamp_put in migration 204 is migration 190's, plus the one line", () => {
  it("writes the same statement as migration 190", () => {
    expect(statementOf("migrations/204_stamped_snapshot_join.sql")).toBe(statementOf("migrations/190_sync_stamps.sql"));
    expect(statementOf("migrations/204_stamped_snapshot_join.sql")).toContain("ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET");
  });
  it("the snapshot of the schema (db/schema.sql) holds the statement of migration 190 (204 and the schema's own copy), and 205's, which adds saw and meta", () => {
    expect(statementOf("schema.sql")).toBe(statementOf("migrations/190_sync_stamps.sql"));
    const text = readFileSync(join(dir, "schema.sql"), "utf8");
    const own = readFileSync(join(dir, "migrations/205_stamp_saw_heads.sql"), "utf8");
    // schema.sql carries migration 205 after the dump, from its first statement on, word for word
    expect(text.replace(/\s+/g, " ")).toContain(own.slice(own.indexOf("ALTER TABLE sync_stamps ADD COLUMN IF NOT EXISTS saw")).replace(/\s+/g, " "));
  });
  it("205 keeps the statement of 190 in sync_stamp_put_over, with saw and meta added to the columns it writes", () => {
    const text = readFileSync(join(dir, "migrations/205_stamp_saw_heads.sql"), "utf8");
    const body = text.slice(text.indexOf("CREATE OR REPLACE FUNCTION sync_stamp_put_over"), text.indexOf("CREATE OR REPLACE FUNCTION sync_stamp_put_row")).replace(/\s+/g, " ");
    expect(body).toContain("INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)");
    expect(body).toContain("ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter, author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;");
    expect(body).toContain("IF sync_import_active(p_ws) THEN RETURN; END IF;");
  });
  it("the one added line is the stand-aside check and nothing else", () => {
    const text = readFileSync(join(dir, "migrations/204_stamped_snapshot_join.sql"), "utf8");
    const body = text.slice(text.indexOf("CREATE OR REPLACE FUNCTION sync_stamp_put"), text.indexOf("CREATE OR REPLACE FUNCTION structure_log_import_skip"));
    expect(body).toContain("IF sync_import_active(p_ws) THEN RETURN; END IF;");
    expect(body.match(/\bTHEN\b/g)).toHaveLength(1);
  });
});
