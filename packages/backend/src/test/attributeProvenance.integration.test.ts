// Integration test for attribute PROVENANCE (sync-protocol §7 step 1,
// architecture-debt #1). Runs against a real Postgres and asserts:
//   - each of the 4 input rails tags node_attributes.source correctly
//     (ui | markdown | frontmatter | dispatcher)
//   - the ATTRIBUTE_SET event payload carries `source`
//   - the deterministic merge tie-break (ui > frontmatter > markdown >
//     dispatcher) refuses to let a lower-priority rail clobber a higher one,
//     while same-source / higher-source overwrites still win.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.
//
// To run:
//   DATABASE_URL=postgres://.../onden_test npx vitest run \
//     src/test/attributeProvenance.integration.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import { syncAttributesAndDispatch, syncFrontmatterAttributes } from "../services/nodes.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { runCascade } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => {
  c.set("actor", currentActor);
  await next();
});
app.route("/api/nodes", nodeRouter);

const post = (body: unknown) =>
  app.request("/api/nodes", {
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

async function sourceOf(nodeId: string, key: string): Promise<string | null> {
  const r = await q<{ source: string }>(
    `SELECT source FROM node_attributes WHERE node_id = $1 AND key = $2`,
    [nodeId, key],
  );
  return r.rows[0]?.source ?? null;
}

async function valueOf(nodeId: string, key: string): Promise<string | null> {
  const r = await q<{ value: string }>(
    `SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`,
    [nodeId, key],
  );
  return r.rows[0]?.value ?? null;
}

async function lastSetPayload(nodeId: string, key: string) {
  const r = await q<{ payload: { key: string; source?: string } }>(
    `SELECT payload FROM domain_events
      WHERE event_type = 'ATTRIBUTE_SET' AND target_id = $1 AND payload->>'key' = $2
      ORDER BY id DESC LIMIT 1`,
    [nodeId, key],
  );
  return r.rows[0]?.payload ?? null;
}

describe.skipIf(!isTestDb)("attribute provenance (DB)", () => {
  let workspaceId: string;
  const ids = { human: "", agent: "", defaultSpace: "" };

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test', 'default')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
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
    ids.defaultSpace = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const humanCtx = (): ActorCtx => ({ id: ids.human, name: "Human", role: "admin", type: "human" });
  const agentCtx = (): ActorCtx => ({ id: ids.agent, name: "Agent", role: "editor", type: "agent" });

  async function makeNode(): Promise<string> {
    currentActor = humanCtx();
    // In the default space (spaces model), so the agent — an editor there —
    // may write it too; a top-level create would be the human's personal note.
    const res = await post({ title: "prov " + Math.random(), markdown: "body", space_id: ids.defaultSpace });
    expect(res.status).toBe(201); // POST /api/nodes → 201 Created
    return ((await res.json()) as { id: string }).id;
  }

  it("UI explicit PUT (human) tags source='ui' + event carries it", async () => {
    const id = await makeNode();
    currentActor = humanCtx();
    const res = await putAttr(id, "status", { value: "open" });
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe("ui");
    expect(await sourceOf(id, "status")).toBe("ui");
    expect((await lastSetPayload(id, "status"))?.source).toBe("ui");
  });

  it("PUT by an agent actor tags source='dispatcher'", async () => {
    const id = await makeNode();
    currentActor = agentCtx();
    const res = await putAttr(id, "auto", { value: "1" });
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe("dispatcher");
    expect(await sourceOf(id, "auto")).toBe("dispatcher");
  });

  it("markdown-inline sync tags source='markdown'", async () => {
    const id = await makeNode();
    await syncAttributesAndDispatch(workspaceId, id, "text\nprio:: high\nmore", humanCtx());
    expect(await valueOf(id, "prio")).toBe("high");
    expect(await sourceOf(id, "prio")).toBe("markdown");
  });

  it("frontmatter sync tags source='frontmatter'", async () => {
    const id = await makeNode();
    await syncFrontmatterAttributes(workspaceId, id, "---\nauthor: ada\n---\nbody", humanCtx());
    expect(await valueOf(id, "author")).toBe("ada");
    expect(await sourceOf(id, "author")).toBe("frontmatter");
  });

  // ── Deterministic tie-break: ui > frontmatter > markdown > dispatcher ──────

  it("dispatcher cannot clobber an explicit UI value", async () => {
    const id = await makeNode();
    currentActor = humanCtx();
    await putAttr(id, "k", { value: "ui-value" }); // source=ui
    // A lowest-rail write on the same key must be refused.
    await dispatchAttributeChangeViaBuiltin(workspaceId, id, agentCtx(), "k", "dispatcher-value");
    expect(await valueOf(id, "k")).toBe("ui-value");
    expect(await sourceOf(id, "k")).toBe("ui");
  });

  it("markdown cannot clobber a frontmatter value, but frontmatter overwrites markdown", async () => {
    const id = await makeNode();
    // frontmatter first → priority 3
    await syncFrontmatterAttributes(workspaceId, id, "---\ntopic: a\n---\nbody", humanCtx());
    expect(await sourceOf(id, "topic")).toBe("frontmatter");
    // markdown (priority 2) must NOT clobber the frontmatter value
    await syncAttributesAndDispatch(workspaceId, id, "topic:: b", humanCtx());
    expect(await valueOf(id, "topic")).toBe("a");
    expect(await sourceOf(id, "topic")).toBe("frontmatter");
    // frontmatter (same/higher) re-writes fine
    await syncFrontmatterAttributes(workspaceId, id, "---\ntopic: c\n---\nbody", humanCtx());
    expect(await valueOf(id, "topic")).toBe("c");
  });

  it("same-source rewrite always wins (behaviour-preserving common case)", async () => {
    const id = await makeNode();
    currentActor = humanCtx();
    await putAttr(id, "s", { value: "v1" });
    await putAttr(id, "s", { value: "v2" });
    expect(await valueOf(id, "s")).toBe("v2");
    expect(await sourceOf(id, "s")).toBe("ui");
  });
});

// A write on the lowest-priority ("dispatcher") rail under the precedence rule,
// as an agent's or an older derived write makes it.
async function dispatchAttributeChangeViaBuiltin(
  workspaceId: string,
  nodeId: string,
  actor: ActorCtx,
  key: string,
  value: string,
): Promise<void> {
  await runCascade({ actor, workspaceId, authority: { kind: "node", nodeId, op: "write_node" }, causeEventId: undefined }, () => recordAttributeChange({
    workspaceId, nodeId, key, actor,
    next: { value, value_type: "text", source: "dispatcher" }, rule: "priority",
    authority: { kind: "cascade" }, uiContext: "test.dispatcher.rail",
  }));
}
