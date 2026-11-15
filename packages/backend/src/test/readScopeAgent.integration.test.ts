// Bearer-token space scope on BULK reads (audit #1) against a real Postgres.
// Reads (sync/query/tags/...) must not let a space-scoped agent exfiltrate
// notes outside its grant: a token sees only notes in the spaces its agent is a
// member of; its
// principal (no tokenScope) sees every space it belongs to. Tag definitions
// are global and carry no permission.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";

// This router harness injects identity; database snapshot/policy remain real.
vi.mock("../services/actorReadSnapshot.js", () => import("./helpers/injectedActorReadSnapshot.js"));
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, event, getWorkspaceId } from "../db.js";
import syncRouter from "../routes/sync.js";
import queryRouter from "../routes/query.js";
import tagsRouter from "../routes/tags.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/sync", syncRouter);
app.route("/api/query", queryRouter);
app.route("/api/tags", tagsRouter);

let owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" }; // no tokenScope = principal
// A token reaches its agent's space memberships, so "scoped to space A" is an
// agent that is a member of A only; "empty" is an agent in no space.
let agentBoth: ActorCtx = { id: "", name: "Bot both", role: "editor", type: "agent" };
let agentA: ActorCtx = { id: "", name: "Bot A", role: "editor", type: "agent" };
let agentNone: ActorCtx = { id: "", name: "Bot none", role: "editor", type: "agent" };
const scoped = (agent: ActorCtx): ActorCtx => ({
  ...agent,
  tokenScope: { tokenId: "t", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
});

// domain_events is append-only + shared across integration files; ?since=0 hits
// the 500-row LIMIT and could miss our events. Sync from a baseline captured
// before this suite created its nodes, so we see only our own deltas.
let sinceBaseline = 0;
const syncIds = async (): Promise<string[]> => {
  const r = await app.request(`/api/sync?since=${sinceBaseline}`);
  return ((await r.json()).nodes.upsert as Array<{ id: string }>).map((n) => n.id);
};
// Only this suite's two tags: an unfiltered query returns the first page of
// every note the reader can read, which in the shared DB need not hold ours.
let tagNames: string[] = [];
const queryIds = async (): Promise<string[]> => {
  const r = await app.request("/api/query", { method: "POST", body: JSON.stringify({ tags: tagNames }), headers: { "Content-Type": "application/json" } });
  return ((await r.json()).rows as Array<{ id: string }>).map((n) => n.id);
};

describe.skipIf(!isTestDb)("bearer-token space scope on bulk reads (DB)", () => {
  let WS = "", inScope = "", outScope = "", allowedTag = "", otherTag = "", spaceA = "", spaceB = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default')
             ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, owner);
    agentBoth = await persistActor(WS, agentBoth);
    agentA = await persistActor(WS, agentA);
    agentNone = await persistActor(WS, agentNone);
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [agentNone.id]);
    spaceA = await makeSpace(WS, `rsa-a-${Date.now()}`,
      [{ id: owner.id, permission: "edit" }, { id: agentBoth.id, permission: "edit" }, { id: agentA.id, permission: "edit" }]);
    spaceB = await makeSpace(WS, `rsa-b-${Date.now()}`,
      [{ id: owner.id, permission: "edit" }, { id: agentBoth.id, permission: "edit" }]);
    sinceBaseline = (await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.m as unknown as number;

    const mkTag = async (name: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','class_tag',$2,$3,'') RETURNING id`,
      [WS, name, `tag-${name}-${Date.now()}`],
    )).rows[0]!.id;
    const mkNode = async (title: string, tagId: string, spaceId: string) => {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,'secret') RETURNING id`,
        [WS, title, `${title}-${Date.now()}`],
      )).rows[0]!.id;
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
      await putInSpace(id, spaceId);
      // A NODE_CREATED event so the node shows up in the sync delta from since=0.
      await event(WS, "NODE_CREATED", "node", id, { title }, "user", owner.id);
      return id;
    };
    tagNames = [`allowed-${Date.now()}`, `other-${Date.now()}`];
    allowedTag = await mkTag(tagNames[0]!);
    otherTag = await mkTag(tagNames[1]!);
    inScope = await mkNode("InScope", allowedTag, spaceA);
    outScope = await mkNode("OutScope", otherTag, spaceB);
  });

  it("the principal owner sees both nodes (no tokenScope = unrestricted)", async () => {
    currentActor = owner;
    // (sync/query also surface the class_tag nodes — assert containment.)
    expect(await syncIds()).toEqual(expect.arrayContaining([inScope, outScope]));
    expect(await queryIds()).toEqual(expect.arrayContaining([inScope, outScope]));
  });

  it("a token sees every space its agent is a member of", async () => {
    currentActor = scoped(agentBoth);
    expect(await syncIds()).toEqual(expect.arrayContaining([inScope, outScope]));
    expect(await queryIds()).toEqual(expect.arrayContaining([inScope, outScope]));
  });

  it("a token whose agent is in one space sees only the in-scope node, never the out-of-scope one", async () => {
    currentActor = scoped(agentA);
    const s = await syncIds();
    expect(s).toContain(inScope);
    expect(s).not.toContain(outScope);
    const query = await queryIds();
    expect(query).toContain(inScope);
    expect(query).not.toContain(outScope);
  });

  it("a token whose agent is in no space sees no notes", async () => {
    currentActor = scoped(agentNone);
    const s = await syncIds();
    const query = await queryIds();
    for (const id of [inScope, outScope]) {
      expect(s).not.toContain(id);
      expect(query).not.toContain(id);
    }
  });

  it("tag definitions are global: a token that reaches one space still lists every tag", async () => {
    currentActor = scoped(agentA);
    const r = await app.request("/api/tags");
    const ids = ((await r.json()) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([allowedTag, otherTag]));
  });
});
