// realPostgresAlso: the rule is arithmetic and the one clock row it must leave alone; nothing here depends on the engine
// A stamp from another node may not put this node's clock far into the future (spine/stamps.ts MAX_FOREIGN_CLOCK_AHEAD_MS):
// a reading at the bound is taken, one millisecond past it refuses the whole batch before anything is written, and a stamp
// from long ago is taken as it is.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { adoptForeignStamp, assertForeignClockWithinBound } from "../spine/stamps.js";

// The bound is ten minutes (spine/stamps.ts MAX_FOREIGN_CLOCK_AHEAD_MS); the tests state it as the number so that a change of it shows here.
const BOUND = 10 * 60 * 1000;
const ahead = { code: "stamp_clock_ahead", status: 422 };

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe("the clock bound on foreign stamps (pure rule)", () => {
  const now = 1_800_000_000_000;
  it("takes a reading exactly at the bound and refuses one millisecond past it", () => {
    expect(() => assertForeignClockWithinBound(now + BOUND, now)).not.toThrow();
    expect(() => assertForeignClockWithinBound(now + BOUND + 1, now)).toThrow(expect.objectContaining(ahead));
  });
  it("takes a reading from long ago, and refuses a reading that is not a number", () => {
    expect(() => assertForeignClockWithinBound(1, now)).not.toThrow();
    expect(() => assertForeignClockWithinBound(Number.NaN, now)).toThrow(expect.objectContaining(ahead));
    expect(() => assertForeignClockWithinBound(Number.POSITIVE_INFINITY, now)).toThrow(expect.objectContaining(ahead));
  });
  it("answers 422 with a code the client can branch on", () => {
    try { assertForeignClockWithinBound(now * 2, now); } catch (e) { expect(e).toMatchObject({ status: 422, code: "stamp_clock_ahead" }); return; }
    throw new Error("did not throw");
  });
});

describe.skipIf(!isTestDb)("adoptForeignStamp and the clock bound", () => {
  let ws = "";
  // A workspace of its own: a stamp taken inside the bound moves the clock of its workspace up, and the shared one is another test's.
  beforeAll(async () => { ws = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Clock bound', $1) RETURNING id::text`, [`clock-${randomUUID().slice(0, 8)}`])).rows[0]!.id; });
  afterAll(async () => {
    await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1`, [ws]);
    await seedQ(`DELETE FROM sync_clock WHERE workspace_id = $1`, [ws]);
    await seedQ(`DELETE FROM workspaces WHERE id = $1`, [ws]);
  });
  const clock = async () => (await q<{ hlc_wall: string; hlc_counter: number; next_seq: string }>(`SELECT hlc_wall, hlc_counter, next_seq FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0];
  const foreign = (wall: number) => ({ origin: `phone-${randomUUID()}`, seq: 5, wall, counter: 0, author: null, device: null });

  it("refuses a stamp past the bound and leaves the clock and the transaction's stamp alone", async () => {
    await withEventTransaction(ws, () => adoptForeignStamp(ws, foreign(Date.now() - 1_000))); // the workspace's clock row exists from here
    const before = await clock();
    expect(before).toBeDefined();
    await expect(withEventTransaction(ws, () => adoptForeignStamp(ws, foreign(Date.now() + BOUND + 60_000)))).rejects.toMatchObject(ahead);
    expect(await clock()).toEqual(before);
  });

  it("takes a stamp inside the bound, and one from long ago without moving the clock back", async () => {
    const before = await clock();
    await withEventTransaction(ws, () => adoptForeignStamp(ws, foreign(Date.now() + BOUND - 60_000)));
    const ahead = await clock();
    expect(Number(ahead!.hlc_wall)).toBeGreaterThanOrEqual(Number(before!.hlc_wall));
    await withEventTransaction(ws, () => adoptForeignStamp(ws, foreign(1_000)));
    const after = await clock();
    expect(Number(after!.hlc_wall)).toBeGreaterThanOrEqual(Number(ahead!.hlc_wall));
    expect(after!.next_seq).toBe(before!.next_seq);
  });
});
