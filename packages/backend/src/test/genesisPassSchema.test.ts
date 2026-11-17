// A database made from db/schema.sql (a fresh install) has sync_genesis_pass() exactly as the last migration that defines it (202, redefined by 209), so a later migration that
// ends with `SELECT * FROM sync_genesis_pass()` runs on a fresh install as on an upgraded one. (schema.sql cannot be loaded without the
// production extensions, so this compares the text; the upgrade path runs the migration itself in genesisStampsMigration.integration.test.ts.)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DB = join(dirname(fileURLToPath(import.meta.url)), "../../db");
const migration = readFileSync(join(DB, "migrations/209_place_is_one_write.sql"), "utf8");
const schema = readFileSync(join(DB, "schema.sql"), "utf8");
/** The last definition in the text: what a database that ran it from the top has. */
const functionIn = (text: string) => { const from = text.lastIndexOf("CREATE OR REPLACE FUNCTION sync_genesis_pass()"); return text.slice(from, text.indexOf("$fn$ LANGUAGE plpgsql;", from) + "$fn$ LANGUAGE plpgsql;".length); };

describe("sync_genesis_pass() on a fresh install", () => {
  it("schema.sql defines the same function as migration 209 (202's, without the per-section step)", () => {
    expect(functionIn(migration).length).toBeGreaterThan(1000);
    expect(functionIn(schema)).toBe(functionIn(migration));
    expect(functionIn(schema)).not.toContain("node_attributes._canvas_sections");
  });
});
