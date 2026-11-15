// A database made from db/schema.sql (a fresh install) has sync_genesis_pass() exactly as migration 202 defines it, so a later migration that
// ends with `SELECT * FROM sync_genesis_pass()` runs on a fresh install as on an upgraded one. (schema.sql cannot be loaded without the
// production extensions, so this compares the text; the upgrade path runs the migration itself in genesisStampsMigration.integration.test.ts.)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DB = join(dirname(fileURLToPath(import.meta.url)), "../../db");
const migration = readFileSync(join(DB, "migrations/202_stamps_genesis.sql"), "utf8");
const schema = readFileSync(join(DB, "schema.sql"), "utf8");
const functionIn = (text: string) => text.slice(text.indexOf("CREATE OR REPLACE FUNCTION sync_genesis_pass()"), text.indexOf("$fn$ LANGUAGE plpgsql;") + "$fn$ LANGUAGE plpgsql;".length);

describe("sync_genesis_pass() on a fresh install", () => {
  it("schema.sql defines the same function as migration 202", () => {
    expect(functionIn(migration).length).toBeGreaterThan(1000);
    expect(functionIn(schema)).toBe(functionIn(migration));
  });
});
