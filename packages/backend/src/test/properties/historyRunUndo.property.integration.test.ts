// Random undo / redo of an AI run (History → 「復原這次修改」), through the real routes.
//
// A generated run: an agent writes some existing notes and creates some, then a
// random sequence of "the run writes a note again", "undo these notes", "redo
// these notes" (the chosen notes are any subset, created notes included). A
// small model follows every note; after each step the database must agree.
//
// Invariants (scan 15, M3 / M4 / M5):
//  R1  a note the run created is never undone, never deleted, its text never changes (answered `skipped`);
//  R2  an undo puts every chosen written note back to its text before the run, a redo to the run's latest text;
//      a note not undone cannot be redone (skipped, unchanged);
//  R3  the run reads as undone exactly when every note it wrote (not created) is undone: a partial undo leaves it
//      open, and a note the run writes again after being undone makes the run open again (M5);
//  R4  the notes left after a partial undo can still be undone: the next undo of them succeeds (M4);
//  R5  while the agent's session is open an undo or redo answers 409 and changes nothing; once it ended it works (M5).
//  R6  the prompt of a run (the run card's summary, listMySessions / getSessionLog) is shown only to the person who started
//      it and to the workspace owner, however the reader's role in the space (viewer / editor) and whoever the agent reads
//      for: everyone else who can see the run sees it without the prompt, an empty string (scan 15, M9).
// Each invariant also has a fixed minimal counterexample below.
//
//   PROPS_SEED=123 PROPS_RUNS=100 npx vitest run src/test/properties/historyRunUndo.property.integration.test.ts
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fc from "fast-check";

vi.hoisted(() => { process.env.ONDEN_TIMEZONE = "Asia/Taipei"; });

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../../httpError.js";
import { pool, q } from "../../db.js";
import historyRouter from "../../routes/history.js";
import { localDayId } from "../../localDay.js";
import { startSession } from "../../services/agentSessions.js";
import { endSession } from "../../services/agentSessionStore.js";
import { createNote } from "../../services/noteCreate.js";
import { updateNode } from "../../services/nodeUpdate.js";
import type { ActorCtx } from "../../types.js";
import { getSessionLog, listMySessions } from "../../services/agentTools/sessionMemory.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { agentWorld, sessionActor } from "../helpers/agentSessionFixture.js";
import { checkAsync } from "../helpers/propsConfig.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  return app;
}
const call = async (actor: ActorCtx, path: string, json?: unknown) => {
  const r = await appFor(actor).request(`/api/history${path}`, json === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

afterAll(async () => { await pool.end(); });

type World = Awaited<ReturnType<typeof agentWorld>>;

/** Move events to a chosen time (domain_events is append-only; a fixture may bend that on its own connection). */
async function stamp(ids: string[], at: Date) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE domain_events SET created_at = $2 WHERE id = ANY($1::bigint[])`, [ids, at]);
    await client.query("COMMIT");
  } finally { client.release(); }
}

type Step =
  | { kind: "write"; note: number }
  | { kind: "undo"; mask: number }
  | { kind: "redo"; mask: number };
type Plan = { existing: number; created: number; steps: Step[] };

const planArb: fc.Arbitrary<Plan> = fc.record({
  existing: fc.integer({ min: 1, max: 3 }),
  created: fc.integer({ min: 0, max: 2 }),
}).chain(({ existing, created }) => fc.record({
  existing: fc.constant(existing),
  created: fc.constant(created),
  steps: fc.array(fc.oneof(
    fc.record({ kind: fc.constant("write" as const), note: fc.integer({ min: 0, max: existing - 1 }) }),
    fc.record({ kind: fc.constant("undo" as const), mask: fc.integer({ min: 1, max: 31 }) }),
    fc.record({ kind: fc.constant("redo" as const), mask: fc.integer({ min: 1, max: 31 }) }),
  ), { minLength: 1, maxLength: 7 }),
}));

describe.skipIf(!isTestDb)("history run undo: random undo / redo of an agent run (model based)", () => {
  let w: World;
  let dayCounter = 20; // every plan gets a day of its own: legacy runs are cut by time
  const nextDay = () => localDayId(new Date(Date.now() - ++dayCounter * 86_400_000));

  beforeAll(async () => {
    w = await agentWorld("runundo", { ownWorkspace: { modules: [] } });
    WS = w.ws;
  });

  const lastBodyEvent = async (nodeId: string) =>
    (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id DESC LIMIT 1`, [nodeId])).rows[0]!.id;
  const maxEvent = async () => (await q<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.id;
  const live = async (id: string) => (await q<{ d: boolean }>(`SELECT deleted_at IS NOT NULL AS d FROM content_nodes WHERE id = $1`, [id])).rows[0]!.d === false;

  /** Runs `plan` as a legacy (resident token) run on a day of its own and checks R1–R4. */
  async function runLegacy(plan: Plan): Promise<void> {
    const day = nextDay();
    let minute = 0;
    const tick = async (since: string) => {
      // keep every event of the plan inside one 10-minute-gap run, in order
      const ids = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint ORDER BY domain_events.id`, [WS, since])).rows.map((r) => r.id);
      for (const id of ids) { minute++; await stamp([id], new Date(`${day}T10:${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}+08:00`)); }
    };
    const pre: string[] = [];
    const agentText: string[] = []; // the run's latest text of each existing note
    const ids: string[] = [];
    for (let i = 0; i < plan.existing; i++) { ids.push(await w.note(`n${i}\n`)); pre.push(`n${i}\n`); agentText.push(`n${i}\n`); }
    const madeIds: string[] = [];
    const marker0 = await maxEvent();
    // first writes of every existing note, then the created notes: all the run's
    const written: boolean[] = ids.map(() => true);
    for (let i = 0; i < plan.existing; i++) { agentText[i] = `n${i} agent 0\n`; await updateNode(WS, ids[i]!, { markdown: agentText[i]! }, { actor: w.agent }); }
    for (let c = 0; c < plan.created; c++) {
      madeIds.push((await createNote({ actor: w.agent, workspaceId: WS, title: `made ${w.stamp} ${dayCounter}-${c}`, markdown: `new ${c}\n`, spaceId: w.space, event: { uiContext: "test" } })).node.id as string);
    }
    await tick(marker0);
    const firstEvent = (await q<{ id: string }>(`SELECT min(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint AND actor_id = $3 AND payload ? 'body_hash'`, [WS, marker0, w.agent.id])).rows[0]!.id;
    const run = `legacy:${w.agent.id}:${firstEvent}`;
    const undone: boolean[] = ids.map(() => false);
    const all = [...ids, ...madeIds];
    const pick = (mask: number) => all.filter((_, i) => (mask >> i) & 1);
    const trace: string[] = [];
    const fail = (m: string): never => { throw new Error(`${m}\nplan ${JSON.stringify(plan)}\ntrace\n${trace.join("\n")}`); };

    const checkAfter = async (label: string) => {
      for (let i = 0; i < ids.length; i++) {
        const expected = undone[i] ? pre[i]! : agentText[i]!;
        const got = await w.body(ids[i]!);
        if (got !== expected) fail(`${label}: note ${i} is ${JSON.stringify(got)}, expected ${JSON.stringify(expected)} (R2)`);
      }
      for (let c = 0; c < madeIds.length; c++) {
        if (!(await live(madeIds[c]!)) || (await w.body(madeIds[c]!)) !== `new ${c}\n`) fail(`${label}: created note ${c} was touched (R1)`);
      }
      const card = (await call(w.owner, `/day?date=${day}`)).body.agent_runs?.find((r: { run_id: string }) => r.run_id === run);
      if (!card) fail(`${label}: the run is not on its day`);
      const shouldBeUndone = undone.every(Boolean);
      if (card.undone !== shouldBeUndone) fail(`${label}: card.undone=${card.undone}, expected ${shouldBeUndone} (R3)`);
      for (const n of card.notes) if (madeIds.includes(n.id) !== (n.created === true)) fail(`${label}: created flag wrong for a note (R1/M3)`);
    };

    await checkAfter("start");
    for (const [n, step] of plan.steps.entries()) {
      const marker = await maxEvent();
      if (step.kind === "write") {
        agentText[step.note] = `n${step.note} agent ${n + 1}\n`;
        await updateNode(WS, ids[step.note]!, { markdown: agentText[step.note]! }, { actor: w.agent });
        undone[step.note] = false;
        trace.push(`#${n} run writes note ${step.note} again`);
      } else {
        const chosen = pick(step.mask);
        const r = await call(w.owner, `/agent-runs/${run}/${step.kind}`, { node_ids: chosen });
        trace.push(`#${n} ${step.kind} ${JSON.stringify(chosen.map((id) => all.indexOf(id)))} → ${r.status} ${JSON.stringify(r.body)}`);
        if (r.status !== 200) fail(`step ${n}: ${step.kind} answered ${r.status}`);
        for (const id of chosen) {
          const i = ids.indexOf(id);
          const answeredUndone = r.body.undone.includes(id);
          if (i < 0) { if (answeredUndone || !r.body.skipped.includes(id)) fail(`step ${n}: created note was not skipped (R1)`); continue; }
          if (step.kind === "undo") {
            if (!answeredUndone) fail(`step ${n}: undo of a written note was not carried out (R4)`);
            undone[i] = true;
          } else if (undone[i]) { if (!answeredUndone) fail(`step ${n}: redo of an undone note was not carried out`); undone[i] = false; }
          else if (answeredUndone || !r.body.skipped.includes(id)) fail(`step ${n}: redo of a note that was not undone must be skipped (R2)`);
        }
      }
      await tick(marker);
      await checkAfter(`step ${n}`);
    }
    void written;
  }

  it("random plans: R1–R4", async () => {
    await checkAsync(fc.asyncProperty(planArb, async (plan) => { await runLegacy(plan); }), 25);
  }, 600_000);

  /** R5 with R1: a session's run. */
  async function runSession(mask: number, created: number): Promise<void> {
    const mention = `@${w.handle} 整理`;
    const host = await w.note(mention);
    const { session } = await startSession(w.ws, { actor: w.owner, nodeId: host, target: { blockText: mention } });
    const sess = await sessionActor(session, w.agent);
    const note = await w.note("orig\n");
    await updateNode(WS, note, { markdown: "agent\n" }, { actor: sess });
    const made: string[] = [];
    for (let c = 0; c < created; c++) made.push((await createNote({ actor: sess, workspaceId: WS, title: `smade ${w.stamp} ${session.id.slice(0, 6)}${c}`, markdown: "new\n", spaceId: w.space, event: { uiContext: "test" } })).node.id as string);
    const chosen = [note, ...made].filter((_, i) => (mask >> i) & 1);
    for (const action of ["undo", "redo"]) {
      const r = await call(w.owner, `/agent-runs/${session.id}/${action}`, { node_ids: chosen });
      expect(r.status, `${action} while open`).toBe(409);
      expect(await w.body(note)).toBe("agent\n");
    }
    await endSession(WS, session.id, "cancelled");
    const done = await call(w.owner, `/agent-runs/${session.id}/undo`, { node_ids: chosen });
    expect(done.status).toBe(200);
    expect(await w.body(note)).toBe(chosen.includes(note) ? "orig\n" : "agent\n");
    for (const id of made) { expect(await live(id)).toBe(true); expect(done.body.undone).not.toContain(id); }
  }

  it("random session runs: R5 (and R1)", async () => {
    await checkAsync(fc.asyncProperty(fc.integer({ min: 1, max: 7 }), fc.integer({ min: 0, max: 2 }), runSession), 8);
  }, 600_000);

  /** R6: a run started by member `starter`; every reader of the run's note sees the prompt iff it is the sender or the owner. */
  async function checkPromptVisibility(roles: Array<"viewer" | "editor">, starterIdx: number): Promise<void> {
    const members: ActorCtx[] = [];
    for (const [i, role] of roles.entries()) members.push(await persistActor(WS, { id: "", name: `Member ${w.stamp} ${i}`, role, type: "human" }));
    const space = await makeSpace(WS, `prompt ${w.stamp} ${members[0]!.id.slice(0, 6)}`, [
      { id: w.owner.id, role: "manager" }, { id: w.agent.id, role: "editor" },
      ...members.map((m, i) => ({ id: m.id, role: roles[i]! })),
    ]);
    const secret = `SECRET-${members[0]!.id.slice(0, 8)}-${starterIdx}`;
    const mention = `@${w.handle} ${secret}`;
    const host = await w.note(mention, space);
    const { session } = await startSession(WS, { actor: w.owner, nodeId: host, target: { blockText: mention } });
    const starter = members[starterIdx]!;
    // The run is written under the owner's authority (a viewer's session could not write); only then is the sender swapped.
    const sess = await sessionActor(session, w.agent);
    const note = await w.note("orig\n", space);
    await updateNode(WS, note, { markdown: "agent\n" }, { actor: sess });
    await endSession(WS, session.id, "cancelled");
    await q(`UPDATE agent_sessions SET initiator_id = $2 WHERE id = $1`, [session.id, starter.id]);

    const readers: Array<{ label: string; actor: ActorCtx; sees: boolean }> = [
      { label: "owner", actor: w.owner, sees: true },
      ...members.map((m, i) => ({ label: `member ${i} (${roles[i]})`, actor: m, sees: i === starterIdx })),
    ];
    for (const { label, actor, sees } of readers) {
      const card = (await call(actor, `/day?date=${localDayId()}`)).body.agent_runs?.find((r: { run_id: string }) => r.run_id === session.id);
      expect(card, `${label} sees the run card`).toBeTruthy();
      if (sees) expect(card.summary, `${label} sees the prompt`).toContain(secret);
      else expect(card.summary, `${label} sees no prompt`).toBe("");
      if (!sees) expect(JSON.stringify(card)).not.toContain(secret);
    }
    // The agent reads for the person its token was issued to (the tool handlers directly: the registry's rate limit is not under test).
    for (const { label, person, sees } of [
      { label: "agent for owner", person: w.owner.id, sees: true },
      ...members.map((m, i) => ({ label: `agent for member ${i}`, person: m.id, sees: i === starterIdx })),
      { label: "agent for nobody", person: null as string | null, sees: false },
    ]) {
      const asAgent: ActorCtx = { ...w.agent, tokenScope: { ...w.agent.tokenScope!, issuedBy: person } };
      const ctxOf = { actor: asAgent, workspaceId: WS };
      const listed = (await listMySessions.handler({ nodeId: host, limit: 20 }, ctxOf as never)).find((x) => x.id === session.id);
      const logged = await getSessionLog.handler({ sessionId: session.id }, ctxOf as never);
      for (const got of [listed?.prompt, logged.prompt]) {
        if (sees) expect(got, `${label} sees the prompt`).toContain(secret);
        else expect(got, `${label} sees no prompt`).toBe("");
      }
    }
  }

  it("random readers × roles × starter: the prompt only for the sender and the owner (R6)", async () => {
    await checkAsync(fc.asyncProperty(
      fc.array(fc.constantFrom("viewer" as const, "editor" as const), { minLength: 2, maxLength: 3 }),
      fc.nat(),
      async (roles, pick) => { await checkPromptVisibility(roles, pick % roles.length); },
    ), 8);
  }, 600_000);

  // ── fixed minimal counterexamples ────────────────────────────────────────
  it("M9: a viewer who reads one of the run's notes sees the run card without the prompt", async () => {
    await checkPromptVisibility(["editor", "viewer"], 0);
  }, 60_000);
  it("M5: an open session cannot be undone", async () => { await runSession(1, 0); }, 60_000);
  it("M5: a note the run writes again after an undo makes the run open again", async () => {
    await runLegacy({ existing: 1, created: 0, steps: [{ kind: "undo", mask: 1 }, { kind: "write", note: 0 }] });
  }, 60_000);
  it("M3: a note the run created is skipped, never deleted", async () => {
    await runLegacy({ existing: 1, created: 1, steps: [{ kind: "undo", mask: 3 }] });
  }, 60_000);
  it("M4: a partial undo leaves the run open and the rest undoable", async () => {
    await runLegacy({ existing: 2, created: 0, steps: [{ kind: "undo", mask: 1 }, { kind: "undo", mask: 2 }] });
  }, 60_000);
});
