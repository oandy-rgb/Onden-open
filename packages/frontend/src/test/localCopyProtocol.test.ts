// A local copy written by a build that speaks a newer protocol is not opened by an older one.
import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { CLIENT_PROTOCOL } from "@onden/markdown";
import { prepareLocalDatabase } from "../lib/localDbSchema";
import { localDbErrorCode } from "../lib/localDbErrors";

const protocolOf = (db: import("sql.js").Database) =>
  db.exec("SELECT value FROM sync_state WHERE key = 'local_copy_protocol'")[0]?.values[0]?.[0] ?? null;

describe("local copy protocol", () => {
  it("records the protocol of the build that prepared it, and reopens at the same protocol", async () => {
    const db = new (await initSqlJs()).Database();
    prepareLocalDatabase(db);
    expect(protocolOf(db)).toBe(String(CLIENT_PROTOCOL));
    expect(() => prepareLocalDatabase(db)).not.toThrow();
    db.close();
  });

  it("opens a copy from before the protocol was recorded", async () => {
    const db = new (await initSqlJs()).Database();
    prepareLocalDatabase(db);
    db.run("DELETE FROM sync_state WHERE key = 'local_copy_protocol'");
    expect(() => prepareLocalDatabase(db)).not.toThrow();
    expect(protocolOf(db)).toBe(String(CLIENT_PROTOCOL));
    db.close();
  });

  it("refuses a copy written by a newer protocol, without changing it", async () => {
    const db = new (await initSqlJs()).Database();
    prepareLocalDatabase(db);
    db.run("UPDATE sync_state SET value = ? WHERE key = 'local_copy_protocol'", [String(CLIENT_PROTOCOL + 1)]);
    let thrown: unknown;
    try { prepareLocalDatabase(db); } catch (error) { thrown = error; }
    expect(localDbErrorCode(thrown)).toBe("local_copy_too_new");
    expect(protocolOf(db)).toBe(String(CLIENT_PROTOCOL + 1));
    db.close();
  });
});
