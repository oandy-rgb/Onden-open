// History's numbers agree with each other and with a simple reference.
//
// A generated sequence of operations (people and an AI agent creating, editing, deleting and
// bringing back notes in two spaces, with gaps of 0 minutes to a day between them, so edits land
// on many days and 5-minute runs of saves occur) runs through the real services. Every operation's
// events are then stamped with that operation's time (the test owns the clock). Two readers look:
// the owner (both spaces) and a reader who is in space 1 only. The workspace clock (time zone and
// day start hour) is random too.
//
// Invariants, for each reader and each local day of the last 30 days:
//  H1  /activity: you + agents = the sum of `edits` over /day's notes of that day;
//  H2  /feed's notes of a day are /day's notes (same ids, same edit counts, same order);
//  H3  /activity per space, summed over the spaces, = /activity without a space (you and agents apart);
//  H4  nothing the reader cannot read shows up: no note of space 2 for the space-1 reader, no
//      deleted note, in /day, /feed or /activity;
//  H5  the counts equal a reference computed from the raw saves: per note, saves
//      (NODE_CREATED / NODE_UPDATED / NODE_RESTORED with a body hash) sorted by time, a new edit
//      starts when the gap to the previous save is over 5 minutes, the actor changes, or either
//      save is not a NODE_UPDATED; an edit belongs to the day of its last save; agent edits are
//      the ones whose events carry actor_type ai_agent.
//
// Run count: PROPS_RUNS (default 8: every run builds a workspace), seed PROPS_SEED.
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it, vi } from "vitest";
import { ALIGN_VERSION_TIMES_SQL } from "../helpers/alignVersionTimes.js";
import { Hono } from "hono";
import fc from "fast-check";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../../httpError.js";
import { pool, q } from "../../db.js";
import { localDayId, resetDayClock, setDayClock } from "../../localDay.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import historyRouter from "../../routes/history.js";
import { createNote } from "../../services/noteCreate.js";
import { trashNode, undeleteNode } from "../../services/nodeTrash.js";
import { updateNode } from "../../services/nodeUpdate.js";
import type { ActorCtx } from "../../types.js";
import { agentWorld } from "../helpers/agentSessionFixture.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync } from "../helpers/propsConfig.js";

const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 8;
const MINUTE = 60_000;
const DAYS = 30;

afterAll(async () => { resetDayClock(); await awaitAllDispatchers(); await pool.end(); });

const get = async (actor: ActorCtx, path: string) => {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  const r = await app.request(`/api/history${path}`);
  return { status: r.status, body: (await r.json()) as any };
};

type Op = { k: "create" | "edit" | "delete" | "undelete"; n: number; by: "human" | "agent"; space: 1 | 2; gapMin: number };
const opArb: fc.Arbitrary<Op> = fc.record({
  k: fc.constantFrom("create" as const, "edit" as const, "edit" as const, "edit" as const, "delete" as const, "undelete" as const),
  n: fc.nat(20), by: fc.constantFrom("human" as const, "agent" as const), space: fc.constantFrom(1 as const, 2 as const),
  gapMin: fc.constantFrom(0, 0, 1, 3, 5, 6, 30, 600, 1440, 2000),
});
const CLOCKS = [
  { timeZone: "UTC", dayStartHour: 0 }, { timeZone: "Asia/Taipei", dayStartHour: 4 }, { timeZone: "America/New_York", dayStartHour: 0 },
  { timeZone: "Australia/Lord_Howe", dayStartHour: 2 }, { timeZone: "America/St_Johns", dayStartHour: 6 },
];

type Save = { id: string; target: string; actor: string; type: string; event: string; at: Date };
/** The reference: edits per local day, from raw saves of the given notes. */
function referenceEdits(saves: Save[], clock: { timeZone: string; dayStartHour: number }): Map<string, { you: number; agents: number; perNote: Map<string, number> }> {
  const out = new Map<string, { you: number; agents: number; perNote: Map<string, number> }>();
  const byTarget = new Map<string, Save[]>();
  for (const s of saves) (byTarget.get(s.target) ?? byTarget.set(s.target, []).get(s.target)!).push(s);
  for (const [target, list] of byTarget) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime() || Number(a.id) - Number(b.id));
    let edit: { last: Save; type: string } | null = null;
    const flush = () => {
      if (!edit) return;
      const day = localDayId(edit.last.at, clock);
      const d = out.get(day) ?? out.set(day, { you: 0, agents: 0, perNote: new Map() }).get(day)!;
      if (edit.type === "ai_agent") d.agents++; else d.you++;
      d.perNote.set(target, (d.perNote.get(target) ?? 0) + 1);
    };
    let prev: Save | null = null;
    for (const s of list) {
      const boundary = !prev || s.at.getTime() - prev.at.getTime() > 5 * MINUTE || s.actor !== prev.actor || s.event !== "NODE_UPDATED" || prev.event !== "NODE_UPDATED";
      if (boundary) { flush(); edit = { last: s, type: s.type }; } else { edit!.last = s; }
      prev = s;
    }
    flush();
  }
  return out;
}

describe.skipIf(!isTestDatabase())("History numbers (property)", () => {
  it("H1–H5", async () => {
    await checkAsync(fc.asyncProperty(
      fc.array(opArb, { minLength: 1, maxLength: 14 }), fc.constantFrom(...CLOCKS),
      async (ops, clock) => {
        const w = await agentWorld("hn", { ownWorkspace: { modules: [] } });
        WS = w.ws;
        const reader = await persistActor(w.ws, { id: "", name: `Reader ${w.stamp}`, role: "editor", type: "human" });
        const member = [{ id: w.owner.id, permission: "edit" as const }, { id: w.agent.id, permission: "edit" as const }];
        const space1 = await makeSpace(w.ws, "s1", [...member, { id: reader.id, permission: "edit" }]);
        const space2 = await makeSpace(w.ws, "s2", member);
        const spaces = { 1: space1, 2: space2 } as const;
        setDayClock(clock);

        const base = Date.UTC(2026, 0, 10, 9, 0, 0);
        let time = base;
        const notes: Array<{ id: string; space: 1 | 2; deleted: boolean; deletedRoot: boolean; text: string }> = [];
        const trace: string[] = [];
        let counter = 0;
        for (const op of ops) {
          time += op.gapMin * MINUTE;
          const actor = op.by === "agent" ? w.agent : w.owner;
          const target = notes.length ? notes[op.n % notes.length]! : null;
          const since = Number((await q<{ m: string }>(`SELECT coalesce(max(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.m);
          try {
            if (op.k === "create" || !target) {
              const text = `t${++counter}\n`;
              const id = (await createNote({ actor, workspaceId: w.ws, title: `hn ${counter}`, markdown: text, spaceId: spaces[op.space], event: { uiContext: "test" } })).node.id as string;
              notes.push({ id, space: op.space, deleted: false, deletedRoot: false, text });
              trace.push(`create #${notes.length - 1} space${op.space} by ${op.by} at +${(time - base) / MINUTE}min`);
            } else if (op.k === "edit" && !target.deleted) {
              target.text = `${target.text}e${++counter}\n`;
              await updateNode(w.ws, target.id, { markdown: target.text }, { actor });
              trace.push(`edit #${notes.indexOf(target)} by ${op.by} at +${(time - base) / MINUTE}min`);
            } else if (op.k === "delete" && !target.deleted) {
              await trashNode(w.owner, w.ws, target.id);
              target.deleted = target.deletedRoot = true;
              trace.push(`delete #${notes.indexOf(target)}`);
            } else if (op.k === "undelete" && target.deletedRoot) {
              await undeleteNode(w.owner, w.ws, target.id);
              target.deleted = target.deletedRoot = false;
              trace.push(`undelete #${notes.indexOf(target)}`);
            }
          } finally {
            await awaitAllDispatchers();
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL session_replication_role = replica");
              await client.query(`UPDATE domain_events SET created_at = $3 WHERE workspace_id = $1 AND id > $2`, [WS, since, new Date(time)]);
              await client.query(ALIGN_VERSION_TIMES_SQL);
              await client.query("COMMIT");
            } finally { client.release(); }
          }
        }
        const fail = (m: string) => `${m}\nclock ${JSON.stringify(clock)}\nsteps:\n${trace.join("\n")}`;
        const until = localDayId(new Date(time), clock);
        const raw = (await q<{ id: string; target_id: string; actor_id: string; actor_type: string; event_type: string; created_at: Date }>(
          `SELECT id::text, target_id, actor_id, actor_type, event_type, created_at FROM domain_events
            WHERE workspace_id = $1 AND event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND payload ? 'body_hash'`, [WS])).rows
          .map((r): Save => ({ id: r.id, target: r.target_id, actor: r.actor_id, type: r.actor_type, event: r.event_type, at: r.created_at }));

        const readers = [
          { who: w.owner, name: "owner", sees: (n: (typeof notes)[number]) => !n.deleted },
          { who: reader, name: "reader", sees: (n: (typeof notes)[number]) => !n.deleted && n.space === 1 },
        ];
        for (const { who, name, sees } of readers) {
          const visible = new Set(notes.filter(sees).map((n) => n.id));
          const ref = referenceEdits(raw.filter((s) => visible.has(s.target)), clock);
          const activity = (await get(who, `/activity?days=${DAYS}&until=${until}`)).body.days as Array<{ date: string; you: number; agents: number }>;
          const perSpace = await Promise.all([space1, space2].map(async (s) => (await get(who, `/activity?days=${DAYS}&until=${until}&space=${s}`)).body.days as typeof activity));
          const feed = (await get(who, `/feed?days=31&until=${until}`)).body.days as Array<{ date: string; notes: Array<{ id: string; edits: number; space_id: string }> }>;
          for (const day of activity) {
            const dayRes = (await get(who, `/day?date=${day.date}`)).body.notes as Array<{ id: string; edits: number; space_id: string }>;
            const label = `${name} ${day.date}`;
            const sumEdits = dayRes.reduce((n, x) => n + x.edits, 0);
            expect(day.you + day.agents, fail(`H1 ${label}`)).toBe(sumEdits);
            const feedNotes = feed.find((f) => f.date === day.date)?.notes ?? [];
            expect(feedNotes.map((x) => [x.id, x.edits]), fail(`H2 ${label}`)).toEqual(dayRes.map((x) => [x.id, x.edits]));
            const split = perSpace.map((p) => p.find((d) => d.date === day.date)!);
            expect({ you: split.reduce((n, d) => n + d.you, 0), agents: split.reduce((n, d) => n + d.agents, 0) }, fail(`H3 ${label}`)).toEqual({ you: day.you, agents: day.agents });
            for (const x of [...dayRes, ...feedNotes]) expect(visible.has(x.id), fail(`H4 ${label}: ${x.id} is not readable`)).toBe(true);
            const expected = ref.get(day.date);
            expect({ you: day.you, agents: day.agents }, fail(`H5 ${label}`)).toEqual({ you: expected?.you ?? 0, agents: expected?.agents ?? 0 });
            expect(new Map(dayRes.map((x) => [x.id, x.edits])), fail(`H5 notes ${label}`)).toEqual(expected?.perNote ?? new Map());
          }
        }
      },
    ), RUN_CAP);
  }, 600_000);
});
