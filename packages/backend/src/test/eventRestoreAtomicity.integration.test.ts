import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { q, event, withTransaction } from "../db.js";
import { apiOnError } from "../httpError.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import inboxRouter from "../routes/inbox.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { randomUUID } from "node:crypto";
import { IdempotentReplay, withIdempotencyKey } from "../spine/idempotency.js";
import { AuthorityError } from "../spine/authority.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { putBlob } from "../services/blobs.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
const actor: ActorCtx = { id: "restore-contract-admin", name: "Restore admin", role: "admin", type: "human" };
let workspaceId = "";

// Keep the real DB/transaction implementation; only bind the HTTP workspace to
// this suite's isolated workspace instead of sharing the app's default fixture.
vi.mock("../db.js", async (original) => ({
  ...await original<typeof import("../db.js")>(),
  getWorkspaceId: async () => workspaceId,
}));

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/inbox", inboxRouter);

async function makeNode(title: string): Promise<string> {
  return (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, title, slug, markdown, source_type, node_type)
     VALUES ($1, $2, gen_random_uuid()::text, '', 'manual', 'content') RETURNING id`,
    [workspaceId, title],
  )).rows[0]!.id;
}

async function conflictChain() {
  const rootNode = await makeNode("Later title");
  const childNode = await makeNode("Generated child");
  const rootEvent = await event(workspaceId, "NODE_UPDATED", "node", rootNode,
    { title: "Agent title" }, "ai_agent", "original-agent", {
      txMeta: { prev_field_values: { title: "Original title" } },
    });
  await event(workspaceId, "NODE_CREATED", "node", childNode, {}, "ai_agent", "original-agent", {
    triggeredBy: rootEvent,
  });
  return { rootNode, childNode, rootEvent };
}

async function expectChildIntact(childNode: string, rootEvent: string) {
  expect((await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [childNode])).rows[0]!.deleted_at).toBeNull();
  expect((await q(
    `SELECT id FROM domain_events WHERE workspace_id = $1 AND tx_meta ? 'restored_from' AND
      (target_id = $2 OR tx_meta->>'restored_from' = $3)`,
    [workspaceId, childNode, rootEvent],
  )).rows).toHaveLength(0);
}

describe.skipIf(!isTestDb)("event restore atomic operation (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Restore contract', gen_random_uuid()::text) RETURNING id`,
    )).rows[0]!.id;
    Object.assign(actor, await persistActor(workspaceId, actor));
  });

  it("rolls back successful descendants when the primary event has a conflict", async () => {
    const chain = await conflictChain();
    expect(await restoreEvent(chain.rootEvent, { actor, workspaceId, cascade: true })).toMatchObject({ code: "patch_conflict" });
    await expectChildIntact(chain.childNode, chain.rootEvent);
  });

  it("rolls back the restore savepoint while an outer review transaction continues", async () => {
    const chain = await conflictChain();
    let marker = "";
    await withTransaction(async () => {
      const result = await restoreEvent(chain.rootEvent, { actor, workspaceId, cascade: true });
      expect(result).toMatchObject({ code: "patch_conflict" });
      marker = await event(workspaceId, "REVIEW_ATTEMPT_RECORDED", "domain_event", chain.rootEvent, {}, "user", actor.id);
    });
    await expectChildIntact(chain.childNode, chain.rootEvent);
    expect((await q(`SELECT id FROM domain_events WHERE id = $1::bigint`, [marker])).rows).toHaveLength(1);
  });

  it("the inbox reject route leaves both review and descendants unchanged after conflict", async () => {
    const chain = await conflictChain();
    const response = await app.request(`/api/inbox/${chain.rootEvent}/reject`, { method: "POST" });
    expect(response.status).toBe(409);
    await expectChildIntact(chain.childNode, chain.rootEvent);
    expect((await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [chain.rootEvent])).rows).toHaveLength(0);
  });

  it("a denied descendant rolls back a root that was revived before its children", async () => {
    const parent = await makeNode("Deleted parent");
    const child = await makeNode("Admin-delete child");
    const editor = await persistActor(workspaceId, { ...actor, role: "editor" });
    // The editor may write the parent (default space) but only view the child's space.
    await putInSpace(child, await makeSpace(workspaceId, `viewer-only-${randomUUID()}`, [
      { id: actor.id, role: "manager" }, { id: editor.id, role: "viewer" },
    ]));
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [parent]);
    const original = await event(workspaceId, "NODE_DELETED", "node", parent, {}, "user", actor.id);
    await event(workspaceId, "NODE_CREATED", "node", child, {}, "user", actor.id, { triggeredBy: original });

    await expect(restoreEvent(original, { actor: editor, workspaceId, cascade: true })).rejects.toThrow(AuthorityError);
    expect((await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [parent])).rows[0]!.deleted_at).not.toBeNull();
    expect((await q(`SELECT id FROM domain_events WHERE workspace_id = $1 AND tx_meta->>'restored_from' = $2`, [workspaceId, original])).rows).toHaveLength(0);
  });

  it("a refused cascade does not consume the request key or its next valid retry", async () => {
    const chain = await conflictChain();
    const key = randomUUID();
    await withIdempotencyKey(key, async () => {
      expect(await restoreEvent(chain.rootEvent, { actor, workspaceId, cascade: true })).toMatchObject({ code: "patch_conflict" });
      expect((await q(`SELECT 1 FROM idempotency_keys WHERE key = $1`, [key])).rows).toHaveLength(0);
      await seedQ(`UPDATE content_nodes SET title = 'Agent title' WHERE id = $1`, [chain.rootNode]);
      expect(await restoreEvent(chain.rootEvent, { actor, workspaceId, cascade: true })).toMatchObject({ restored: true });
    });
    expect((await q(`SELECT 1 FROM idempotency_keys WHERE key = $1`, [key])).rows).toHaveLength(1);
  });

  it("concurrent restore-as-new requests with one key create only one copy", async () => {
    const source = await makeNode("Current title");
    const original = await event(workspaceId, "NODE_UPDATED", "node", source,
      { title: "Current title", body_hash: await putBlob("") }, "user", actor.id, {
      txMeta: { prev_field_values: { title: "Previous title" } },
    });
    const key = randomUUID();
    const attempt = () => withIdempotencyKey(key, () => restoreEvent(original, { actor, workspaceId, as_new_node: true }));
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const replay = results.find((result) => result.status === "rejected");
    expect(replay?.status === "rejected" && replay.reason).toBeInstanceOf(IdempotentReplay);
    expect((await q(
      `SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_CREATED' AND tx_meta->>'restored_from' = $2`,
      [workspaceId, original],
    )).rows).toHaveLength(1);
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [source])).rows[0]!.title).toBe("Current title");
  });

  it("restore-as-new preserves source descendants even when an older client sends cascade=true", async () => {
    const source = await makeNode("Current source");
    const child = await makeNode("Generated child");
    await seedQ(`UPDATE content_nodes SET parent_id = $1 WHERE id = $2`, [source, child]);
    const tag = await seedClassTag(workspaceId, {
      name: "Kept tag", slug: randomUUID(), title: "Kept tag", nodeSlug: randomUUID(),
    });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [source, tag.tagId]);
    const original = await event(workspaceId, "NODE_UPDATED", "node", source,
      { title: "Current source", body_hash: await putBlob("") }, "user", actor.id, {
      txMeta: { prev_field_values: { title: "Earlier source" } },
    });
    await event(workspaceId, "NODE_CREATED", "node", child, {}, "user", actor.id, { triggeredBy: original });
    await event(workspaceId, "TAG_APPLIED", "node", source, { tag_id: tag.tagId }, "user", actor.id, { triggeredBy: original });

    const result = await restoreEvent(original, { actor, workspaceId, as_new_node: true, cascade: true });
    expect(result).toMatchObject({ restored: true, restore_event_type: "NODE_CREATED" });
    expect("cascade" in result).toBe(false);
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [source])).rows[0]!.title).toBe("Current source");
    expect((await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [child])).rows[0]!.deleted_at).toBeNull();
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [source, tag.tagId])).rows).toHaveLength(1);
    expect((await q(
      `SELECT 1 FROM domain_events WHERE workspace_id = $1 AND tx_meta ? 'restored_from' AND target_id = ANY($2::text[])`,
      [workspaceId, [source, child]],
    )).rows).toHaveLength(0);
  });

  it("restores descendants by numeric event order across a digit boundary", async () => {
    const parent = await makeNode("Root");
    const node = await makeNode("C");
    const root = await event(workspaceId, "NODE_CREATED", "node", parent, {}, "user", actor.id);
    // Only in the isolated test DB: advance (never rewind) the sequence so the
    // next pair crosses 99→100 / 999→1000. Same-width ids would let a lexical
    // ORDER BY pass this regression even though real cascades remain broken.
    // Each run moves the sequence one digit up, so stop below 2^53: past that,
    // JSON cursors (sync, events) round and unrelated suites fail. A test DB
    // that far along has crossed every boundary already; recreate it.
    const next = (await q<{ id: string }>(`SELECT nextval(pg_get_serial_sequence('domain_events', 'id'))::text AS id`)).rows[0]!.id;
    let boundary = 10n ** BigInt(next.length);
    if (boundary - 2n <= BigInt(next)) boundary *= 10n;
    if (boundary <= 10n ** 15n) {
      await q(`SELECT setval(pg_get_serial_sequence('domain_events', 'id'), $1::bigint, true)`, [String(boundary - 2n)]);
    }
    const first = await event(workspaceId, "NODE_UPDATED", "node", node, { title: "B" }, "user", actor.id, {
      triggeredBy: root, txMeta: { prev_field_values: { title: "A" } },
    });
    const second = await event(workspaceId, "NODE_UPDATED", "node", node, { title: "C" }, "user", actor.id, {
      triggeredBy: root, txMeta: { prev_field_values: { title: "B" } },
    });
    const result = await restoreEvent(root, { actor, workspaceId, cascade: true });
    expect(result).toMatchObject({ restored: true, cascade: [
      { event_id: second, result: "ok" }, { event_id: first, result: "ok" },
    ] });
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [node])).rows[0]!.title).toBe("A");
  });
});
