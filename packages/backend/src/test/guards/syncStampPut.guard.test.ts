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
  it("the snapshot of the schema (db/schema.sql) ends with the same statement", () => {
    expect(statementOf("schema.sql", true)).toBe(statementOf("migrations/190_sync_stamps.sql"));
  });
  it("the one added line is the stand-aside check and nothing else", () => {
    const text = readFileSync(join(dir, "migrations/204_stamped_snapshot_join.sql"), "utf8");
    const body = text.slice(text.indexOf("CREATE OR REPLACE FUNCTION sync_stamp_put"), text.indexOf("CREATE OR REPLACE FUNCTION structure_log_import_skip"));
    expect(body).toContain("IF sync_import_active(p_ws) THEN RETURN; END IF;");
    expect(body.match(/\bTHEN\b/g)).toHaveLength(1);
  });
});
