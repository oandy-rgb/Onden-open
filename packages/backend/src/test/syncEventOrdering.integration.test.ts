// Real PostgreSQL, real /api/sync. Covers two ways a client used to miss data
// permanently: a standalone event() overtaking an uncommitted writer (the
// cursor then skipped the writer's lower id), and body-derived wikilink edges
// that changed without EDGE_* events.
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import syncRouter from "../routes/sync.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { syncWikilinkEdges, relinkTarget } from "../services/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";
import { withTransaction } from "../db.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let admin: ActorCtx = { id: "ordering-admin", name: "Test", role: "admin", type: "human" };

type Edge = { id: string; source_node_id: string; target_node_id: string };
type Delta = { last_event_id: number | string; edges: { upsert: Edge[]; delete: string[]; replace_for?: string[] } };

async function pull(since: number | string): Promise<Delta> {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
  app.route("/api/sync", syncRouter);
  const res = await app.request("/api/sync", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ since }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<Delta>;
}
async function cursor(): Promise<string> {
  return (await db.q<{ id: string }>("SELECT COALESCE(MAX(id),0)::text AS id FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].id;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function createNote(title: string, markdown = ""): Promise<string> {
  const id = randomUUID();
  await mutate({
    actor: admin, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type: "NODE_CREATED", targetType: "node", targetId: id, payload: { title } },
    apply: async () => {
      await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
        VALUES($1::uuid,$2,'manual','content',$3,$4,$5)`, [id, ws, title, `${title}-${id}`, markdown]);
      await withTransaction(() => syncWikilinkEdges(ws, id, markdown));
      await withTransaction(() => relinkTarget(ws, [id]));
    },
  });
  return id;
}
async function editBody(id: string, markdown: string): Promise<void> {
  await mutate({
    actor: admin, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { fields: ["markdown"] } },
    apply: async () => {
      await seedQ("UPDATE content_nodes SET markdown=$2 WHERE id=$1", [id, markdown]);
      await withTransaction(() => syncWikilinkEdges(ws, id, markdown));
    },
  });
}
const pair = (e: Edge) => `${e.source_node_id}->${e.target_node_id}`;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("sync event ordering and derived edges", () => {
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Sync ordering',$1) RETURNING id", [randomUUID()])).rows[0].id;
    admin = await persistActor(ws, admin);
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]); });

  it.skipIf(needsSecondConnection)("a standalone audit event waits for an uncommitted writer, so the cursor cannot skip it", async () => {
    const note = await createNote("ordering");
    const before = await cursor();
    const entered = gate(), commit = gate();
    const writer = withEventTransaction(ws, async () => {
      const id = await db.event(ws, "NODE_UPDATED", "node", note, { title: "late" }, "user", admin.id);
      entered.release();
      await commit.promise;
      return id;
    });
    await entered.promise;

    let standaloneDone = false;
    const standalone = db.event(ws, "AGENT_TOOL_CALLED", "tool", "probe", { ok: true }, "ai_agent", admin.id)
      .then((id) => { standaloneDone = true; return id; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      // Before the fix the audit row autocommitted with a higher id and this
      // sync acknowledged it, permanently skipping the writer's NODE_UPDATED.
      expect(standaloneDone).toBe(false);
      expect(String((await pull(before)).last_event_id)).toBe(before);
    } finally { commit.release(); }

    const [writerId, standaloneId] = await Promise.all([writer, standalone]);
    expect(BigInt(standaloneId)).toBeGreaterThan(BigInt(writerId));
    expect(BigInt((await pull(before)).last_event_id)).toBeGreaterThanOrEqual(BigInt(standaloneId));
  });

  it("ships wikilink edges added and removed by a body edit, with stable ids", async () => {
    const b = await createNote("beta"), c = await createNote("gamma");
    const a = await createNote("alpha", "see [[beta]]");
    const linkAB = `${a}->${b}`, linkAC = `${a}->${c}`;

    let since = await cursor();
    await editBody(a, "see [[beta]] and [[gamma]]");
    let delta = await pull(since);
    expect(delta.edges.replace_for).toContain(a);
    expect(delta.edges.upsert.map(pair).sort()).toEqual([linkAB, linkAC].sort());
    const abId = delta.edges.upsert.find((e) => pair(e) === linkAB)!.id;

    since = await cursor();
    await editBody(a, "only [[gamma]] now");
    delta = await pull(since);
    // The removed link is absent from the authoritative set for `a`; the
    // surviving link keeps its row id instead of being re-created.
    expect(delta.edges.replace_for).toContain(a);
    expect(delta.edges.upsert.map(pair)).toEqual([linkAC]);
    expect((await db.q("SELECT 1 FROM node_edges WHERE id=$1", [abId])).rows).toHaveLength(0);

    since = await cursor();
    const acBefore = delta.edges.upsert[0]!.id;
    await editBody(a, "still [[gamma]], reworded");
    delta = await pull(since);
    expect(delta.edges.upsert.map((e) => e.id)).toEqual([acBefore]);
  });

  it("ships backlinks wired from existing notes when their target is created", async () => {
    const source = await createNote("source", "waiting for [[newcomer]]");
    const since = await cursor();
    const target = await createNote("newcomer");
    const delta = await pull(since);
    expect(delta.edges.replace_for).toContain(target);
    expect(delta.edges.upsert.map(pair)).toContain(`${source}->${target}`);
  });
});
