// A mirror prepared by a build with another schema version forgets when its
// last whole bootstrap was stored, so the next open fetches one (a new column
// is NULL on old rows until then).

import { describe, expect, it } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import { MIRROR_SCHEMA_VERSION, prepareLocalDatabase } from "../lib/localDbSchema";

const state = (db: Database, key: string) =>
  db.exec("SELECT value FROM sync_state WHERE key = ?", [key])[0]?.values[0]?.[0] ?? null;

describe("mirror schema version", () => {
  it("a mirror from before the version was recorded loses its full_refresh_at, once", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    prepareLocalDatabase(db);
    db.run("DELETE FROM sync_state WHERE key = 'mirror_schema_version'"); // as an older build left it
    db.run("INSERT INTO sync_state (key, value) VALUES ('full_refresh_at', '1700000000000')");
    prepareLocalDatabase(db);
    expect(state(db, "full_refresh_at")).toBeNull();
    expect(state(db, "mirror_schema_version")).toBe(String(MIRROR_SCHEMA_VERSION));
    db.run("INSERT INTO sync_state (key, value) VALUES ('full_refresh_at', '1700000000001')");
    prepareLocalDatabase(db); // same version: a later open keeps it
    expect(state(db, "full_refresh_at")).toBe("1700000000001");
    db.close();
  });

  it("a different recorded version (a schema bump) clears it too", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    prepareLocalDatabase(db);
    db.run("UPDATE sync_state SET value = ? WHERE key = 'mirror_schema_version'", [String(MIRROR_SCHEMA_VERSION - 1)]);
    db.run("INSERT INTO sync_state (key, value) VALUES ('full_refresh_at', '1700000000000')");
    prepareLocalDatabase(db);
    expect(state(db, "full_refresh_at")).toBeNull();
    db.close();
  });
  // The server's migration 194 replaced every sidebar pointer's id. A device that already holds the old ids must read
  // them again (a whole bootstrap) rather than keep a pin the server can no longer find.
  it("a copy from before the pointer ids were rewritten (version 1) holds its old pointer until the whole bootstrap it now asks for", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    prepareLocalDatabase(db);
    db.run("UPDATE sync_state SET value = '1' WHERE key = 'mirror_schema_version'");
    db.run("INSERT INTO sync_state (key, value) VALUES ('full_refresh_at', ?)", [String(Date.now())]); // a refresh this very hour
    db.run("INSERT INTO pointers (id, parent_id, target_id) VALUES ('old-pointer-id', 'parent', 'target')");
    prepareLocalDatabase(db);
    expect(MIRROR_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    expect(state(db, "full_refresh_at")).toBeNull(); // the next open fetches a whole bootstrap
    db.close();
  });
});
