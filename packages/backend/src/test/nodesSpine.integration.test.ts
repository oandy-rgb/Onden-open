// Integration test for the nodes.ts → spine migration. Runs the ACTUAL route
// handlers (via the Hono app) against a real Postgres, asserting the spine's
// promises that unit tests can't reach:
//   - attribution is DERIVED and correct (agent → ai_agent, human → user;
//     never the old 'user'/'unknown' hardcode)
//   - authority is unskippable (viewer can't create; no actor → 401)
//   - the mutation + its event are one atomic, attributed unit
//
// SAFETY: only runs against a dedicated *_test database. With no test DB (the
// normal `vitest run` on the host) the whole suite skips, so the 405 pure-logic
// tests stay green without a DB.
//
// To run:
//   DATABASE_URL=postgres://.../onden_test npx vitest run src/test/nodesSpine.integration.test.ts
// (the DB must be reachable; in this repo that means a container on the compose
//  network — see the docker run command used to validate this file.)

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import bookmarkRouter from "../routes/bookmark.js";
import importRouter from "../modules/importers/routes.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { adminOnlySpace, putInSpace, joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { updateNode } from "../services/agentTools/updateNode.js";
import { callTool } from "../services/agentTools/index.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { computeRollupAttributes, computeInheritedAttributes } from "../services/nodeAttributes.js";
import { searchNodes } from "../services/nodeSearch.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

// A workspace of its own per run (the routes read it through getWorkspaceId):
// the file wipes its workspace's notes before and after, which it may only do
// to a workspace it made, and its fixed slugs then never meet another run's.
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
// The bookmark route fetches the page for its title; the test is about attribution, not the network (a real fetch of
// example.com made it time out when the network was slow).
vi.mock("../services/pageMeta.js", async (original) => ({
  ...await original<typeof import("../services/pageMeta.js")>(),
  fetchPageMeta: async () => ({ title: "Example", description: "", imageUrl: null }),
}));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// The acting actor for the next request — flipped per test to exercise parity.
let currentActor: ActorCtx | null = null;

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => {
  c.set("actor", currentActor);
  await next();
});
app.route("/api/nodes", nodeRouter);
app.route("/api/events", eventsRouter);
app.route("/api/bookmark", bookmarkRouter);
app.route("/api/import", importRouter);

const postImport = (files: unknown) =>
  app.request("/api/import/obsidian", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });

// Spaces (docs/architecture/spaces.md): a top-level create would land in the
// creator's personal space, private to them. These tests hand notes between
// actors, so creates go to the workspace's default space unless told otherwise.
let defaultSpaceId = "";
const post = (body: unknown) =>
  app.request("/api/nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space_id: defaultSpaceId, ...(body as Record<string, unknown>) }),
  });

const putTag = (id: string, tagId: string) => app.request(`/api/nodes/${id}/tags/${tagId}`, { method: "PUT" });
const delTag = (id: string, tagId: string) => app.request(`/api/nodes/${id}/tags/${tagId}`, { method: "DELETE" });

const del = (id: string) => app.request(`/api/nodes/${id}`, { method: "DELETE" });

const restoreEvt = (eventId: string) =>
  app.request(`/api/events/${eventId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

const postBookmark = (body: unknown) =>
  app.request("/api/bookmark", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patch = (id: string, body: unknown) =>
  app.request(`/api/nodes/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getVersions = (id: string) => app.request(`/api/nodes/${id}/versions`);
const restoreVersion = (id: string, versionId: string, body: unknown = {}) =>
  app.request(`/api/nodes/${id}/versions/${versionId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const putAttr = (id: string, key: string, body: unknown) =>
  app.request(`/api/nodes/${id}/attributes/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const delAttr = (id: string, key: string) =>
  app.request(`/api/nodes/${id}/attributes/${key}`, { method: "DELETE" });

async function lastEvent(eventType: string, targetId: string) {
  const r = await q<{ actor_type: string; actor_id: string; payload: Record<string, unknown> }>(
    `SELECT actor_type, actor_id, payload FROM domain_events
      WHERE event_type = $1 AND target_id = $2
      ORDER BY id DESC LIMIT 1`,
    [eventType, targetId],
  );
  return r.rows[0];
}

// Latest registry audit event (AGENT_TOOL_CALLED / AGENT_TOOL_FAILED) for a tool.
async function lastAudit(toolName: string) {
  const r = await q<{ actor_type: string; actor_id: string; event_type: string }>(
    `SELECT actor_type, actor_id, event_type FROM domain_events
      WHERE event_type IN ('AGENT_TOOL_CALLED', 'AGENT_TOOL_FAILED')
        AND tx_meta->>'tool_name' = $1 AND workspace_id = $2
      ORDER BY id DESC LIMIT 1`,
    [toolName, workspaceId],
  );
  return r.rows[0];
}

describe.skipIf(!isTestDb)("nodes.ts spine migration (DB)", () => {
  const ids = { human: "", agent: "", viewer: "", viewerAgent: "" };

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Nodes spine', $1) RETURNING id`, [`nodes-spine-${randomUUID()}`],
    )).rows[0]!.id;
    const mk = async (name: string, type: string, role: string) => {
      const r = await q<{ id: string }>(
        `INSERT INTO actors (workspace_id, name, type) VALUES ($1, $2, $3) RETURNING id`,
        [workspaceId, name, type],
      );
      await joinDefaultSpace(workspaceId, r.rows[0]!.id, role);
      return r.rows[0]!.id;
    };
    ids.human = await mk("Human", "human", "admin");
    ids.agent = await mk("Agent", "agent", "editor");
    ids.viewer = await mk("Viewer", "human", "viewer");
    // A viewer with no personal space (an agent): it can write nowhere. A human
    // viewer may still write in their own personal space.
    ids.viewerAgent = await mk("Viewer agent", "agent", "viewer");
    defaultSpaceId = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  afterAll(async () => {
    // domain_events carrying body_hash are append-only (migration 052) — they can
    // never be deleted, and neither can the workspace/actors they reference (a
    // cascade would hit the same guard). So teardown only clears the deletable,
    // unreferenced tables; events + workspace + actors stay as harmless leftovers
    // in onden_test. beforeAll's workspace upsert is idempotent, and extra actors
    // don't affect assertions (tests use the ids minted in this run).
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [workspaceId]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [workspaceId]);
    await pool.end();
  });

  it("agent create → event attributed ai_agent + agent id (kills the 'unknown' bug)", async () => {
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = await post({ title: "by agent", markdown: "hello" });
    expect(res.status).toBe(201);
    const node = (await res.json()) as { id: string };
    const ev = await lastEvent("NODE_CREATED", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    expect(ev?.actor_id).toBe(ids.agent);
  });

  it("human create → event attributed user + human id", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const res = await post({ title: "by human", markdown: "hi" });
    expect(res.status).toBe(201);
    const node = (await res.json()) as { id: string };
    const ev = await lastEvent("NODE_CREATED", node.id);
    expect(ev?.actor_type).toBe("user");
    expect(ev?.actor_id).toBe(ids.human);
  });

  // A viewer of the default space cannot create there (their own personal
  // space is theirs to write; that is not what this pins).
  it("viewer cannot create → 403 (authority is unskippable)", async () => {
    currentActor = { id: ids.viewer, name: "Viewer", role: "viewer", type: "human" };
    const res = await post({ title: "by viewer" });
    expect(res.status).toBe(403);
  });

  it("no actor → 401 (requireActor; no silent anonymous write)", async () => {
    currentActor = null;
    const res = await post({ title: "anon" });
    expect(res.status).toBe(401);
  });

  it("delete is attributed + soft-deletes (event + state atomic)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const created = (await (await post({ title: "to delete" })).json()) as { id: string };
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = await del(created.id);
    expect(res.status).toBe(200);
    const ev = await lastEvent("NODE_DELETED", created.id);
    expect(ev?.actor_type).toBe("ai_agent");
    const row = await q<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM content_nodes WHERE id = $1`,
      [created.id],
    );
    expect(row.rows[0]?.deleted_at).not.toBeNull();
  });

  it("PATCH content as agent → NODE_UPDATED attributed + prior version captured", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "v1", markdown: "first" })).json()) as { id: string };
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = await patch(node.id, { markdown: "second" });
    expect(res.status).toBe(200);
    const ev = await lastEvent("NODE_UPDATED", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    // events->hash->blobs: the prior body is retained as a blob, addressed by the
    // NODE_CREATED event's body_hash (no separate version table).
    const ver = await q<{ markdown: string }>(
      `SELECT b.content AS markdown FROM domain_events e
       JOIN blobs b ON b.hash = e.payload->>'body_hash'
       WHERE e.target_id = $1 AND e.payload ? 'body_hash'`,
      [node.id],
    );
    expect(ver.rows.some((r) => r.markdown === "first")).toBe(true);
    const row = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [node.id]);
    expect(row.rows[0]?.markdown).toBe("second");
  });

  it("set attribute as agent → ATTRIBUTE_SET attributed + row written", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "attr host" })).json()) as { id: string };
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = await putAttr(node.id, "status", { value: "reading" });
    expect(res.status).toBe(200);
    const ev = await lastEvent("ATTRIBUTE_SET", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    const row = await q<{ value: string }>(
      `SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'status'`,
      [node.id],
    );
    expect(row.rows[0]?.value).toBe("reading");
  });

  it("delete attribute as agent → ATTRIBUTE_DELETED attributed + row gone", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "attr host 2" })).json()) as { id: string };
    await putAttr(node.id, "status", { value: "x" });
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = await delAttr(node.id, "status");
    expect(res.status).toBe(200);
    const ev = await lastEvent("ATTRIBUTE_DELETED", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    const row = await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = 'status'`, [node.id]);
    expect(row.rows.length).toBe(0);
  });

  it("restore by agent → restore event attributed ai_agent (restore.ts threads actor_type)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "to restore" })).json()) as { id: string };
    await del(node.id); // emits NODE_DELETED
    const delEv = await q<{ id: string }>(
      `SELECT id FROM domain_events WHERE event_type = 'NODE_DELETED' AND target_id = $1 ORDER BY id DESC LIMIT 1`,
      [node.id],
    );
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = await restoreEvt(String(delEv.rows[0]!.id));
    expect(res.status).toBe(200);
    // restoring a NODE_DELETED emits a NODE_UNDELETED, attributed to the agent
    // who restored — NOT the old hardcoded 'user'.
    const ev = await lastEvent("NODE_UNDELETED", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    expect(ev?.actor_id).toBe(ids.agent);
  });

  it("bookmark create by agent → BOOKMARK_CREATED attributed ai_agent", async () => {
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = await postBookmark({ url: "https://example.com", title: "Example" });
    expect(res.status).toBe(201);
    const ev = await q<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM domain_events WHERE event_type = 'BOOKMARK_CREATED' ORDER BY id DESC LIMIT 1`,
    );
    expect(ev.rows[0]?.actor_type).toBe("ai_agent");
    expect(ev.rows[0]?.actor_id).toBe(ids.agent);
  });

  it("agent updateNode TOOL → NODE_UPDATED attributed ai_agent (agent write on the spine)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "agent target", markdown: "before" })).json()) as { id: string };
    // Invoke the agent tool directly with an agent actor — it now goes through
    // the same mutate() as the human PATCH route, so attribution is derived.
    const agentActor: ActorCtx = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = (await updateNode.handler({ id: node.id, markdown: "after (by agent)" }, {
      actor: agentActor,
      workspaceId,
      dryRun: false,
    })) as { event_id: string };
    expect(res.event_id).toBeTruthy();
    const ev = await lastEvent("NODE_UPDATED", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    expect(ev?.actor_id).toBe(ids.agent);
    const row = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [node.id]);
    expect(row.rows[0]?.markdown).toBe("after (by agent)");
  });

  it("agent applyTag TOOL via registry → TAG_APPLIED + AGENT_TOOL_CALLED both ai_agent", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "tag target" })).json()) as { id: string };
    const tag = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
       VALUES ($1, 'class_tag', 'manual', 'ApplyTag', 'apply-tag', '') RETURNING id`,
      [workspaceId],
    );
    const tagId = tag.rows[0]!.id;
    const agentActor: ActorCtx = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const res = (await callTool("applyTag", { nodeId: node.id, tagId }, {
      actor: agentActor, workspaceId, dryRun: false,
    })) as { applied: boolean };
    expect(res.applied).toBe(true);
    // The tool now routes its authority through the spine; the TAG_APPLIED event
    // (from the dispatcher) is attributed to the agent…
    const ev = await lastEvent("TAG_APPLIED", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    // …and the registry audit derives the actor_type too (was hardcoded ai_agent,
    // which is right HERE but mis-recorded a human hitting the tool via the UI).
    const audit = await lastAudit("applyTag");
    expect(audit?.event_type).toBe("AGENT_TOOL_CALLED");
    expect(audit?.actor_type).toBe("ai_agent");
    expect(audit?.actor_id).toBe(ids.agent);
    const link = await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [node.id, tagId]);
    expect(link.rows.length).toBe(1);
  });

  it("agent removeTag TOOL via registry → TAG_REMOVED ai_agent + link gone", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "untag target" })).json()) as { id: string };
    const tag = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
       VALUES ($1, 'class_tag', 'manual', 'RemoveTag', 'remove-tag', '') RETURNING id`,
      [workspaceId],
    );
    const tagId = tag.rows[0]!.id;
    const agentActor: ActorCtx = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    await callTool("applyTag", { nodeId: node.id, tagId }, { actor: agentActor, workspaceId, dryRun: false });
    const res = (await callTool("removeTag", { nodeId: node.id, tagId }, {
      actor: agentActor, workspaceId, dryRun: false,
    })) as { removed: boolean };
    expect(res.removed).toBe(true);
    const ev = await lastEvent("TAG_REMOVED", node.id);
    expect(ev?.actor_type).toBe("ai_agent");
    const link = await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [node.id, tagId]);
    expect(link.rows.length).toBe(0);
  });

  it("human calls a tool via registry → AGENT_TOOL_CALLED attributed user (kills the hardcoded ai_agent)", async () => {
    const humanActor: ActorCtx = { id: ids.human, name: "Human", role: "admin", type: "human" };
    await callTool("searchNodes", { query: "tag target" }, { actor: humanActor, workspaceId, dryRun: false });
    const audit = await lastAudit("searchNodes");
    expect(audit?.event_type).toBe("AGENT_TOOL_CALLED");
    expect(audit?.actor_type).toBe("user");
    expect(audit?.actor_id).toBe(ids.human);
  });

  // Post-merge (events->hash->blobs): version history is derived from the event
  // log — every body-changing event carries body_hash, so EVERY save is a
  // version (the old 5-minute CoW throttle is gone with the trigger). A version
  // body is the blob the event points at.
  async function versionCount(nodeId: string) {
    const r = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events e
       WHERE e.target_id = $1 AND e.payload ? 'body_hash'`, [nodeId]);
    return r.rows[0]!.n;
  }

  it("every body edit is a version (events->hash->blobs; no throttle)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "throttle-agent", markdown: "m0" })).json()) as { id: string };
    const agentActor: ActorCtx = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    // Two rapid body-only edits — no throttle now, each is its own version.
    await updateNode.handler({ id: node.id, markdown: "m1" }, { actor: agentActor, workspaceId, dryRun: false });
    await updateNode.handler({ id: node.id, markdown: "m2" }, { actor: agentActor, workspaceId, dryRun: false });
    expect(await versionCount(node.id)).toBe(3); // NODE_CREATED m0 + NODE_UPDATED m1 + m2
    const bodies = await q<{ markdown: string }>(
      `SELECT b.content AS markdown FROM domain_events e
       JOIN blobs b ON b.hash = e.payload->>'body_hash'
       WHERE e.target_id = $1 AND e.payload ? 'body_hash' ORDER BY e.created_at, e.id`, [node.id]);
    expect(bodies.rows.map((r) => r.markdown)).toEqual(["m0", "m1", "m2"]);
  });

  it("restoring a version carries body_hash and is itself a version (audit gap closed)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "ver-restore", markdown: "m0" })).json()) as { id: string };
    await patch(node.id, { markdown: "m1" });
    const versions = (await (await getVersions(node.id)).json()) as { id: string; markdown: string }[];
    expect(versions.map((v) => v.markdown)).toEqual(["m1", "m0"]); // DESC by created_at,id
    const m0Version = versions.find((v) => v.markdown === "m0")!;
    const res = await restoreVersion(node.id, m0Version.id);
    expect(res.status).toBe(200);
    // live body reverted to m0
    const row = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [node.id]);
    expect(row.rows[0]?.markdown).toBe("m0");
    // The restore is itself a body_hash-carrying NODE_RESTORED, so it shows up as
    // a version — previously the restore emitted no body_hash and was invisible to
    // both /versions and blob-GC (the audit's high-risk gap).
    expect(await versionCount(node.id)).toBe(3); // m0 create + m1 patch + restore→m0
    expect((await lastEvent("NODE_RESTORED", node.id))?.actor_type).toBe("user");
  });

  describe("restoring a version whose title differs from the note's", () => {
    // 「草稿」 was renamed 「期末報告」 after its text was written; the text is then edited again.
    async function renamedNote() {
      currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
      const node = (await (await post({ title: "草稿", markdown: "old text" })).json()) as { id: string; slug: string };
      await patch(node.id, { title: "期末報告" });
      await patch(node.id, { markdown: "new text" });
      const versions = (await (await getVersions(node.id)).json()) as { id: string; title: string; markdown: string }[];
      const draft = versions.find((v) => v.title === "草稿")!;
      const row = async () => (await q<{ title: string; slug: string; markdown: string }>(`SELECT title, slug, markdown FROM content_nodes WHERE id = $1`, [node.id])).rows[0]!;
      const renamed = await row();
      return { node, draft, row, renamed };
    }

    it("text only (restore_title: false) keeps the title and the slug, and the event records the kept title", async () => {
      const { node, draft, row, renamed } = await renamedNote();
      expect(renamed.title).toBe("期末報告");
      expect((await restoreVersion(node.id, draft.id, { restore_title: false })).status).toBe(200);
      const after = await row();
      expect(after).toEqual({ title: "期末報告", slug: renamed.slug, markdown: "old text" });
      expect(((await lastEvent("NODE_RESTORED", node.id))?.payload as { title: string }).title).toBe("期末報告");
    });

    it("with restore_title: true both come back, and the slug follows the title", async () => {
      const { node, draft, row, renamed } = await renamedNote();
      expect((await restoreVersion(node.id, draft.id, { restore_title: true })).status).toBe(200);
      const after = await row();
      expect(after.title).toBe("草稿");
      expect(after.markdown).toBe("old text");
      expect(after.slug).not.toBe(renamed.slug);
    });

    it("an old client that sends no flag keeps today's behaviour: the title comes back", async () => {
      const { node, draft, row } = await renamedNote();
      expect((await restoreVersion(node.id, draft.id)).status).toBe(200);
      expect(await row()).toMatchObject({ title: "草稿", markdown: "old text" });
    });

    it("refuses a flag that is not a boolean and writes nothing", async () => {
      const { node, draft, row, renamed } = await renamedNote();
      expect((await restoreVersion(node.id, draft.id, { restore_title: "no" })).status).toBe(400);
      expect(await row()).toEqual(renamed);
    });
  });

  it("editing a node enqueues a backup intent through the outbox (not fire-and-forget)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "ob-edit", markdown: "v0" })).json()) as { id: string; slug: string };
    await q(`DELETE FROM outbox WHERE dedup_key = $1`, [`github_backup:${node.id}`]); // isolate from the create enqueue
    await patch(node.id, { markdown: "v1" });
    const r = await q<{ payload: { markdown: string } }>(
      `SELECT payload FROM outbox WHERE dedup_key = $1 AND status = 'pending'`, [`github_backup:${node.id}`]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.payload.markdown).toBe("v1");
  });

  it("restoring a NODE_UPDATED re-enqueues a backup so git re-converges (not silent divergence)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "ob-restore", markdown: "orig" })).json()) as { id: string; slug: string };
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    await patch(node.id, { markdown: "edited" });
    const ev = await q<{ id: string }>(
      `SELECT id FROM domain_events WHERE event_type='NODE_UPDATED' AND target_id=$1 ORDER BY id DESC LIMIT 1`, [node.id]);
    // Clear what create+patch enqueued, so a fresh row proves the RESTORE enqueued.
    await q(`DELETE FROM outbox WHERE dedup_key IN ($1, $2)`, [`git_commit:${node.id}`, `github_backup:${node.id}`]);
    const res = await restoreEvt(String(ev.rows[0]!.id));
    expect(res.status).toBe(200);
    const r = await q<{ payload: { markdown: string } }>(
      `SELECT payload FROM outbox WHERE dedup_key = $1 AND status = 'pending'`, [`git_commit:${node.id}`]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.payload.markdown).toBe("orig"); // reverted body queued → backup re-converges to PG
  });

  it("DELETE attribute answers a person without access the same whether or not the property exists", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "attr-probe" })).json()) as { id: string };
    const secretSpace = await adminOnlySpace(workspaceId, `attr-probe-${Date.now()}`, [ids.human]);
    await putInSpace(node.id, secretSpace);
    expect((await putAttr(node.id, "present", { value: "x" })).status).toBe(200);
    currentActor = { id: ids.viewer, name: "Viewer", role: "viewer", type: "human" };
    const withIt = await delAttr(node.id, "present");
    const without = await delAttr(node.id, "absent");
    expect(withIt.status).toBeGreaterThanOrEqual(400);
    expect(without.status).toBe(withIt.status);
    expect(await without.json()).toEqual(await withIt.json());
    // Nothing was removed, and the owner's own no-op removal still answers ok.
    expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = 'present'`, [node.id])).rows.length).toBe(1);
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    expect((await delAttr(node.id, "absent")).status).toBe(200);
  });

  it("human PUT/DELETE tag route flows through the spine — applies, attributes, removes", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "tag-route" })).json()) as { id: string };
    const tag = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
       VALUES ($1, 'class_tag', 'manual', 'RouteTag', 'route-tag', '') RETURNING id`, [workspaceId]);
    const tagId = tag.rows[0]!.id;
    expect((await putTag(node.id, tagId)).status).toBe(200);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2`, [node.id, tagId])).rows.length).toBe(1);
    expect((await lastEvent("TAG_APPLIED", node.id))?.actor_type).toBe("user");
    expect((await delTag(node.id, tagId)).status).toBe(200);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2`, [node.id, tagId])).rows.length).toBe(0);
  });

  it("the internal tag route also rejects a valid token whose agent is in no space", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "scope-gate" })).json()) as { id: string };
    const tag = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
       VALUES ($1, 'class_tag', 'manual', 'ScopeTag', 'scope-tag', '') RETURNING id`, [workspaceId]);
    // A real token is valid but reaches NO space: a token reaches its agent's
    // memberships and this agent has none. This harness tests the domain's
    // defense in depth; the assembled public server already confines bearer
    // credentials to MCP, never general REST.
    const loner = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'No-space agent', 'agent') RETURNING id`, [workspaceId])).rows[0]!.id;
    const token = await createToken(loner, { access: "write" });
    currentActor = await resolveBearerActor(token.plaintext);
    expect(currentActor).not.toBeNull();
    expect((await putTag(node.id, tag.rows[0]!.id)).status).toBe(403);
  });

  it("obsidian import now flows through the spine — nodes get attributed NODE_CREATED", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const res = await postImport([
      { path: "imp-one.md", content: "# One\n\nbody one" },
      { path: "imp-two.md", content: "body two" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number };
    expect(body.imported).toBe(2);
    // Every imported node has a NODE_CREATED event attributed to the importer
    // (previously import emitted NO events at all).
    const created = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events e
        JOIN content_nodes n ON n.id::text = e.target_id
       WHERE e.event_type = 'NODE_CREATED' AND e.actor_type = 'user'
         AND n.workspace_id = $1 AND n.title IN ('imp-one','imp-two')`,
      [workspaceId],
    );
    expect(created.rows[0]!.n).toBe(2);
  });

  it("import requires an editor+ actor (was completely unauthenticated)", async () => {
    currentActor = null;
    expect((await postImport([{ path: "x.md", content: "x" }])).status).toBe(401);
    currentActor = { id: ids.viewerAgent, name: "Viewer agent", role: "viewer", type: "agent" };
    expect((await postImport([{ path: "y.md", content: "y" }])).status).toBe(403);
  });

  it("nested template (child_class_tag_slug) applies the child tag via the full spine path — no cross-connection deadlock", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    // Child class-tag: carries its OWN template child and a field default, so
    // we can prove the full apply path (not a raw pool.query INSERT) ran for the
    // template-applied child tag — TAG_APPLIED, the default and the nested child.
    const { tagId: childTagId } = await seedClassTag(workspaceId, {
      name: "Phase", slug: "phase", nodeSlug: "phase-ct",
      fields: [{ name: "status", type: "text", default: "open" }],
      templateChildren: [{ title: "Subtask", body: "do" }],
    });
    // Parent class-tag: a template slot that applies the child tag to its spawned child.
    const { tagId: parentTagId } = await seedClassTag(workspaceId, {
      name: "Proj2", slug: "proj2", nodeSlug: "proj2-ct",
      fields: [],
      templateChildren: [{ title: "Phase 1", child_class_tag_slug: "Phase" }],
    });

    const node = (await (await post({ title: "nested-tpl-host" })).json()) as { id: string };
    // Apply via the REST route → runs inside the request's withTransaction. This
    // is the path where the old cross-connection pool.query node_tags INSERT would
    // block on the still-uncommitted child's FK → self-deadlock. Must return, not hang.
    const r = await putTag(node.id, parentTagId);
    expect(r.status).toBe(200);

    const phase = await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE parent_id = $1 AND title = 'Phase 1' AND deleted_at IS NULL`, [node.id]);
    expect(phase.rows.length).toBe(1);
    const phaseId = phase.rows[0]!.id;
    // Child tag linked (atomic with the child, same committed tx).
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [phaseId, childTagId])).rows.length).toBe(1);
    // Full spine path: TAG_APPLIED emitted for the child tag on the spawned child.
    expect(await lastEvent("TAG_APPLIED", phaseId)).toBeTruthy();
    // The child tag's schema field DEFAULT was seeded (applyFieldDefaults now runs
    // for template child-tags too, atomic in the same slot tx).
    expect((await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'status'`, [phaseId])).rows[0]?.value).toBe("open");
    // The child tag's OWN template child spawned (recursion).
    expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1 AND title = 'Subtask' AND deleted_at IS NULL`, [phaseId])).rows.length).toBe(1);
  });

  it("siteConfig.ensureConfigNodeId is idempotent on a fresh workspace (fresh-install fix)", async () => {
    // The lookup used to require `tag_schema_id IS NOT NULL`, which never matched
    // the schema-less workspace-config class_tag it had just created — so the 2nd
    // call re-created the tag and hit the (workspace_id, parent_id, title) unique
    // index → 500 on bootstrap. (Found by the full-stack e2e on a fresh onden_test.)
    const first = await ensureConfigNode(workspaceId);
    const second = await ensureConfigNode(workspaceId);
    expect(second).toBe(first);
  });

  it("human rapid body-only edits are each a version too (throttle removed)", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const node = (await (await post({ title: "throttle-human", markdown: "m0" })).json()) as { id: string };
    await patch(node.id, { markdown: "m1" });
    await patch(node.id, { markdown: "m2" });
    // The old 5-min CoW throttle (which exempted agents, migration 048) is GONE
    // with the trigger: every body-changing event carries body_hash, so the human
    // path is 3 too — same as the agent path above. (Was stale-asserting 1.)
    expect(await versionCount(node.id)).toBe(3); // NODE_CREATED m0 + NODE_UPDATED m1 + m2
  });

  // These two endpoints' computation moved to services/nodeAttributes.ts. They
  // had NO prior integration coverage — pin the behaviour against a real DB so
  // the extraction (and the recursive-CTE walks) are verified, not just typed.
  it("computeInheritedAttributes walks ancestors; local + non-inheritable excluded", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const parent = (await (await post({ title: "inh-parent" })).json()) as { id: string };
    const child = (await (await post({ title: "inh-child", parent_id: parent.id })).json()) as { id: string };
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, is_inheritable, value_type, source)
       VALUES ($1,$2,'theme','dark',true,'text','explicit'),
              ($1,$2,'secret','x',false,'text','explicit')`,
      [workspaceId, parent.id],
    );
    const inherited = await computeInheritedAttributes(workspaceId, child.id);
    const theme = inherited.find((a) => a.key === "theme");
    expect(theme?.value).toBe("dark");
    expect(theme?.source_node_id).toBe(parent.id);
    expect(theme?.depth).toBe(1);
    expect(inherited.find((a) => a.key === "secret")).toBeUndefined(); // not inheritable

    // A locally-set key wins over inheritance → drops out of the result.
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, is_inheritable, value_type, source)
       VALUES ($1,$2,'theme','light',false,'text','explicit')`,
      [workspaceId, child.id],
    );
    expect((await computeInheritedAttributes(workspaceId, child.id)).find((a) => a.key === "theme")).toBeUndefined();
  });

  it("computeRollupAttributes counts descendants for a rollup field", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const { tagId } = await seedClassTag(workspaceId, {
      name: "Folder", slug: "kids-schema", nodeSlug: "folder-rollup",
      fields: [{ name: "kids", label: "Kids", rollup: { op: "count" } }],
    });
    const parent = (await (await post({ title: "rollup-parent" })).json()) as { id: string };
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [parent.id, tagId]);
    await post({ title: "rk1", parent_id: parent.id });
    await post({ title: "rk2", parent_id: parent.id });

    const rollups = await computeRollupAttributes(currentActor, workspaceId, parent.id);
    const kids = rollups.find((r) => r.key === "kids");
    expect(kids?.op).toBe("count");
    expect(kids?.value).toBe(2); // two descendants, self excluded

    // Restricted descendants count only for those who can read them: the
    // rollup must not reveal their existence (or values) to a viewer. A subtree
    // lives in one space (the DB refuses a child in another space than its
    // parent), so restrict the whole subtree: move it to an admin-only space.
    await post({ title: "rk3", parent_id: parent.id });
    const viewer: ActorCtx = { id: ids.viewer, name: "Viewer", role: "viewer", type: "human" };
    expect((await computeRollupAttributes(viewer, workspaceId, parent.id)).find((r) => r.key === "kids")?.value).toBe(3);
    const secretSpace = await adminOnlySpace(workspaceId, `rollup-secret-${Date.now()}`, [ids.human]);
    await putInSpace(parent.id, secretSpace);
    const asAdmin = await computeRollupAttributes(currentActor, workspaceId, parent.id);
    expect(asAdmin.find((r) => r.key === "kids")?.value).toBe(3);
    const asViewer = await computeRollupAttributes(viewer, workspaceId, parent.id);
    expect(asViewer.find((r) => r.key === "kids")?.value ?? 0).toBe(0);
  });

  // D50: a rollup reads numbers like typed sorts and filters do — value_type
  // 'number' and NUMBER_PATTERN. A stray "2h", "1e3" or "NaN" is skipped; it
  // no longer drops the whole rollup (it used to fail the ::float cast, and a
  // catch swallowed the error) nor counts as 1000 / poisons the sum with NaN.
  it("computeRollupAttributes sums only stored numbers", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const { tagId } = await seedClassTag(workspaceId, {
      name: "Project", slug: "hours-schema", nodeSlug: "project-rollup",
      fields: [
        { name: "total", label: "Total hours", rollup: { op: "sum", attr: "hours" } },
        { name: "most", label: "Most hours", rollup: { op: "max", attr: "hours" } },
        { name: "least", label: "Least hours", rollup: { op: "min", attr: "hours" } },
      ],
    });
    const parent = (await (await post({ title: "hours-parent" })).json()) as { id: string };
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [parent.id, tagId]);
    const hours: Array<[string, string]> = [
      ["3", "number"], ["4.5", "number"], ["2h", "text"], ["1e3", "number"], ["NaN", "number"], ["7", "text"],
    ];
    for (const [i, [value, valueType]] of hours.entries()) {
      const child = (await (await post({ title: `hours-${i}`, parent_id: parent.id })).json()) as { id: string };
      await seedQ(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, is_inheritable, value_type, source)
         VALUES ($1,$2,'hours',$3,false,$4,'explicit')`,
        [workspaceId, child.id, value, valueType],
      );
    }

    const rollups = await computeRollupAttributes(currentActor, workspaceId, parent.id);
    expect(rollups.find((r) => r.key === "total")?.value).toBe(7.5);
    expect(rollups.find((r) => r.key === "most")?.value).toBe(4.5);
    expect(rollups.find((r) => r.key === "least")?.value).toBe(3);
  });

  // D50: a rollup's tag is read like /api/query `tags` — the name matches
  // case-insensitively and counts child tags (task/bug), not just the exact
  // title. A tag merely sharing a prefix (taskforce) stays out.
  it("computeRollupAttributes counts a tag's members by name", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const { tagId } = await seedClassTag(workspaceId, {
      name: "Epic", slug: "epic-rollup-schema", nodeSlug: "epic-rollup",
      fields: [
        { name: "tasks", label: "Tasks", rollup: { op: "count", tag: "Task" } },
        { name: "points", label: "Points", rollup: { op: "sum", tag: "Task", attr: "points" } },
      ],
    });
    const tag = async (title: string, parentId: string | null) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1, 'manual', 'class_tag', $2, $3, '', $4) RETURNING id::text`,
      [workspaceId, title, `tag-${title}-rollup`, parentId])).rows[0]!.id;
    const task = await tag("task", null);
    const bug = await tag("bug", task);
    const taskforce = await tag("taskforce", null);
    const parent = (await (await post({ title: "epic-parent" })).json()) as { id: string };
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [parent.id, tagId]);
    for (const [title, tagIds, points] of [
      ["epic-task", [task], "3"], ["epic-bug", [bug], "5"], ["epic-force", [taskforce], "8"], ["epic-plain", [], "13"],
    ] as Array<[string, string[], string]>) {
      const child = (await (await post({ title, parent_id: parent.id })).json()) as { id: string };
      for (const t of tagIds) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [child.id, t]);
      await seedQ(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, is_inheritable, value_type, source)
         VALUES ($1,$2,'points',$3,false,'number','explicit')`,
        [workspaceId, child.id, points],
      );
    }

    const rollups = await computeRollupAttributes(currentActor, workspaceId, parent.id);
    expect(rollups.find((r) => r.key === "tasks")?.value).toBe(2);
    expect(rollups.find((r) => r.key === "points")?.value).toBe(8);
  });

  // Search moved to services/nodeSearch.ts — pin pgroonga text match + an
  // attribute filter against the real index (no prior integration coverage).
  it("searchNodes matches body text via pgroonga and AND-composes a filter", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const hit = (await (await post({ title: "znordquux note", markdown: "about znordquux things" })).json()) as { id: string };
    await post({ title: "unrelated", markdown: "nothing to see" });

    const textHits = await searchNodes(workspaceId, "znordquux", currentActor);
    expect(textHits.some((r) => r.id === hit.id)).toBe(true);
    expect(textHits.every((r) => r.title !== "unrelated")).toBe(true);

    // An empty/garbage parse yields no rows (the guard moved into the service).
    expect(await searchNodes(workspaceId, "   ", currentActor)).toEqual([]);

    // Text AND attribute filter: only the node carrying status=reading survives.
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, is_inheritable, value_type, source)
       VALUES ($1,$2,'status','reading',false,'text','explicit')`,
      [workspaceId, hit.id],
    );
    const filtered = await searchNodes(workspaceId, "znordquux status:reading", currentActor);
    expect(filtered.some((r) => r.id === hit.id)).toBe(true);
    const filteredMiss = await searchNodes(workspaceId, "znordquux status:done", currentActor);
    expect(filteredMiss.some((r) => r.id === hit.id)).toBe(false);
  });

  // searchNodes PUSHES the read scope into the query (actor required): a viewer
  // must never match a read-restricted node, and the exclusion happens INSIDE
  // the query (not a post-LIMIT .filter() that under-fills the page).
  it("searchNodes pushes read policy down: a viewer never matches a restricted node", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const tagStamp = Date.now();
    // Restricted = in an admin-only space the viewer is not in.
    const secretSpace = await adminOnlySpace(workspaceId, `srch-secret-${tagStamp}`, [ids.human]);
    const secret = (await (await post({ title: "secret search note", markdown: "qwzzlemarker confidential" })).json()) as { id: string };
    await putInSpace(secret.id, secretSpace);

    // admin: the pushed-down scope admits the restricted node
    const asAdmin = await searchNodes(workspaceId, "qwzzlemarker", currentActor);
    expect(asAdmin.some((r) => r.id === secret.id)).toBe(true);

    // viewer: the scope predicate excludes it inside the query
    const viewer: ActorCtx = { id: ids.viewer, name: "Viewer", role: "viewer", type: "human" };
    const asViewer = await searchNodes(workspaceId, "qwzzlemarker", viewer);
    expect(asViewer.some((r) => r.id === secret.id)).toBe(false);
  });

  // ⑨ create-from-link backlink: a note that [[links]] a title which doesn't
  // exist YET must get its backlink wired when that target is finally created
  // (the gap obsidianBasics.spec.ts recorded). relinkTarget runs
  // on create; a plain mention (no brackets) must NOT fabricate an edge.
  it("creating a node wires backlinks from notes that linked it before it existed", async () => {
    currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" };
    const stamp = Date.now();
    const targetTitle = `Future Topic ${stamp}`;

    // A source that LINKS the not-yet-existing target, and a decoy that only
    // MENTIONS the title in prose (must not produce an edge).
    const srcId = (await (await post({ title: `Linker ${stamp}`, markdown: `See [[${targetTitle}]] soon.` })).json()).id as string;
    const decoyId = (await (await post({ title: `Mentioner ${stamp}`, markdown: `I once read ${targetTitle} somewhere.` })).json()).id as string;

    // No edge yet — the target doesn't exist, so the source's save matched nothing.
    const before = await q(
      `SELECT 1 FROM node_edges WHERE workspace_id=$1 AND source_node_id=$2 AND origin='wikilink'`,
      [workspaceId, srcId]);
    expect(before.rowCount).toBe(0);

    // Create the target — incoming sync should wire src→target, not decoy.
    const targetId = (await (await post({ title: targetTitle, markdown: "the topic, now real" })).json()).id as string;

    const edge = await q<{ source_node_id: string }>(
      `SELECT source_node_id FROM node_edges
        WHERE workspace_id=$1 AND target_node_id=$2 AND origin='wikilink'`,
      [workspaceId, targetId]);
    const sources = edge.rows.map((r) => r.source_node_id);
    expect(sources).toContain(srcId);
    expect(sources).not.toContain(decoyId);
  });
});
