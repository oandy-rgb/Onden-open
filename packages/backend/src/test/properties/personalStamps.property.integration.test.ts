// Random sequences of personal writes (calendars, RSS mutes) must leave the stamp table in step with the data:
// every live row of a stamped table has its whole-row stamp, every deleted row a tombstone and no field stamps, each write is
// one stamp, none skips the entry, and none adds an event. (Proposal causal-stamps-2026-11-12 §8: "any data classified as
// stamped has a stamp after a write and a tombstone after a delete".)
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/personalStamps.property.integration.test.ts
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { pool, q } from "../../db.js";
import { countWritesWithoutStamp } from "../../spine/stamps.js";
import { addCalendar, changeCalendar, removeCalendar } from "../../modules/external_calendars/store.js";
import { muteKeyword, endMute } from "../../modules/rss/mutes.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

type Op =
  | { kind: "addCalendar" } | { kind: "renameCalendar"; pick: number } | { kind: "toggleCalendar"; pick: number } | { kind: "removeCalendar"; pick: number }
  | { kind: "mute"; word: number } | { kind: "endMute"; pick: number };

const ops = fc.array(fc.oneof(
  fc.constant<Op>({ kind: "addCalendar" }),
  fc.nat(9).map((pick): Op => ({ kind: "renameCalendar", pick })),
  fc.nat(9).map((pick): Op => ({ kind: "toggleCalendar", pick })),
  fc.nat(9).map((pick): Op => ({ kind: "removeCalendar", pick })),
  fc.nat(3).map((word): Op => ({ kind: "mute", word })),
  fc.nat(9).map((pick): Op => ({ kind: "endMute", pick })),
), { minLength: 1, maxLength: 14 });

describe.skipIf(!isTestDb)("personal writes keep stamps in step with data (random operations)", () => {
  let ws = "";
  let ada!: ActorCtx;
  const savedKey = process.env.ONDEN_SECRET_KEY;
  beforeAll(async () => {
    process.env.ONDEN_SECRET_KEY = randomBytes(32).toString("hex");
    // A workspace of its own: the counters below are exact, so nothing else may write in it (other test files run in the same database).
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Personal stamps', $1) RETURNING id::text`, [`personal-stamps-${randomUUID()}`])).rows[0]!.id;
    ada = await persistActor(ws, { id: "", name: "Random Ada", role: "admin", type: "human" });
  });
  afterAll(async () => {
    if (savedKey === undefined) delete process.env.ONDEN_SECRET_KEY; else process.env.ONDEN_SECRET_KEY = savedKey;
    await pool.end();
  });

  const seqNow = async () => Number((await q<{ n: string }>(`SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]?.n ?? "1");
  const eventsNow = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.n);

  it("holds after every sequence", async () => {
    const runs = Number(process.env.PROPS_RUNS ?? 12);
    const seed = process.env.PROPS_SEED ? Number(process.env.PROPS_SEED) : undefined;
    await fc.assert(fc.asyncProperty(ops, async (sequence) => {
      const calendars: string[] = [], mutes: string[] = [];
      const gone: Array<{ table: string; id: string }> = [];
      const [seq0, bypass0, events0] = [await seqNow(), await countWritesWithoutStamp(ws), await eventsNow()];
      for (const op of sequence) {
        switch (op.kind) {
          case "addCalendar": {
            const id = randomUUID();
            const added = await addCalendar(ws, ada, { id, name: "c", color: "#333333", href: `https://calendar.example.com/${id}.ics`, host: "calendar.example.com" });
            expect(added, "the person's calendar limit").not.toBe("limit");
            calendars.push(id); break;
          }
          case "renameCalendar": case "toggleCalendar": case "removeCalendar": {
            const id = calendars[op.pick % Math.max(calendars.length, 1)];
            if (!id) { await muteKeyword(ada, ws, `idle-${seq0}`).then((m) => { if (!mutes.includes(m)) mutes.push(m); }); break; }
            if (op.kind === "removeCalendar") { await removeCalendar(ws, ada, id); calendars.splice(calendars.indexOf(id), 1); gone.push({ table: "external_calendars", id }); }
            else await changeCalendar(ws, ada, id, op.kind === "renameCalendar" ? { name: `n${Math.random()}` } : { enabled: Math.random() < 0.5 });
            break;
          }
          case "mute": {
            const id = await muteKeyword(ada, ws, `word-${op.word}-${seq0}`);
            if (!mutes.includes(id)) mutes.push(id);
            break;
          }
          case "endMute": {
            const id = mutes[op.pick % Math.max(mutes.length, 1)];
            if (!id) { const fresh = randomUUID(); await addCalendar(ws, ada, { id: fresh, name: "c", color: "#333333", href: "https://calendar.example.com/x.ics", host: "calendar.example.com" }); calendars.push(fresh); break; }
            await endMute(ada, ws, id); mutes.splice(mutes.indexOf(id), 1); gone.push({ table: "rss_mutes", id });
            break;
          }
        }
      }
      // one stamp per write, none skipped the entry, no event
      expect(await seqNow() - seq0).toBe(sequence.length);
      expect(await countWritesWithoutStamp(ws)).toBe(bypass0);
      expect(await eventsNow()).toBe(events0);
      const stampOf = async (table: string, id: string) => (await q<{ field: string; deleted: boolean }>(
        `SELECT field, deleted FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3`, [ws, table, id])).rows;
      for (const [table, ids] of [["external_calendars", calendars], ["rss_mutes", mutes]] as const) {
        for (const id of ids) expect((await stampOf(table, id)).find((s) => s.field === "*"), `${table} ${id}`).toMatchObject({ deleted: false });
      }
      for (const { table, id } of gone) expect(await stampOf(table, id), `${table} ${id} tombstone`).toEqual([{ field: "*", deleted: true }]);
      // A person keeps at most 10 calendars (MAX_CALENDARS_PER_PERSON): leave none behind for the next sequence.
      for (const id of calendars) await removeCalendar(ws, ada, id);
    }), { numRuns: runs, ...(seed === undefined ? {} : { seed }) });
  }, 120_000);
});
