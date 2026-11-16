// Real PostgreSQL regressions for the September core review. Barriers control
// interleaving; application queries and transactions remain real. External I/O
// is injected; only isolated *_test databases may run this suite.
import { describe, it, beforeAll, afterAll, afterEach, vi } from "vitest";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { pool, q, getWorkspaceId } from "../db.js";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import { updateNode as agentUpdateNode } from "../services/agentTools/updateNode.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { mutate } from "../spine/mutate.js";
import { assertAuthority, AuthorityError } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { enqueueBackup, drainOutbox } from "../services/outbox.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const admin: ActorCtx = { id: "core-review-admin", name: "Review", type: "human", role: "admin" };
const editor: ActorCtx = { ...admin, id: "core-review-editor", role: "editor" };
const delegated: ActorCtx = { ...admin, id: "core-review-agent", type: "agent", tokenScope: {
  tokenId: randomUUID(), allowedTools: null, access: "write", writeMode: "apply", expiresAt: null,
} };
let ws: string;
const created: string[] = [];
const stamp = randomUUID();

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodesRouter);
  app.route("/api/sync", syncRouter);
  return app;
}
const app = appFor(admin);
const patch = async (id: string, body: Record<string, unknown>, actor = admin) => appFor(actor).request(`/api/nodes/${id}`, {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 8000;
  while (!(await check())) {
    assert(Date.now() < end, `Timed out: ${label}`);
    await delay(10);
  }
}
async function waitingWriters(count: number) {
  await until(async () => {
    const r = await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event='advisory'
      AND query LIKE '%pg_advisory_xact_lock%'`);
    return Number(r.rows[0].n) >= count;
  }, `${count} writer(s) blocked after their preflight reads`);
}
async function seedNode(label: string, markdown = "original") {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
    VALUES($1,$2,'manual','content',$3,$4,$5)`, [id,ws,label,`${label}-${stamp}-${id}`,markdown]);
  created.push(id);
  return id;
}
describe.skipIf(!isTestDb)("core consistency under concurrent writes", () => {
  it.skipIf(needsSecondConnection)("rechecks space permission after a queued writer acquires the event lock", async () => {
    // The editor's permission in the note's space drops to view while its write
    // waits on the event lock; the write must see the new permission.
    const id = await seedNode("authority");
    const space = await makeSpace(ws, `authority-${randomUUID()}`, [{ id: editor.id, permission: "edit" }]);
    await putInSpace(id, space);
    const locked = gate(), changePolicy = gate();
    const policyWrite = withEventTransaction(ws, async () => {
      locked.release();
      await changePolicy.promise;
      await q("UPDATE space_members SET permission='view' WHERE space_id=$1 AND actor_id=$2", [space, editor.id]);
    });
    await locked.promise;
    let pending: Promise<Response> | undefined;
    try {
      pending = patch(id, { order_key: "a73" }, editor);
      await waitingWriters(1);
    } finally { changePolicy.release(); }
    await policyWrite;
    const response = await pending!;
    assert.equal(response.status, 403);
    await assert.rejects(() => assertAuthority(editor, { kind: "node", nodeId: id, op: "write_node" }), AuthorityError);
    const row = (await q("SELECT order_key FROM content_nodes WHERE id=$1", [id])).rows[0];
    assert.equal(row.order_key, "a0");
    const fresh = await patch(id, { order_key: "a74" }, editor);
    assert.equal(fresh.status, 403);
    assert.equal((await q("SELECT count(*)::int AS n FROM domain_events WHERE target_id=$1 AND event_type='NODE_UPDATED'", [id])).rows[0].n, 0);
  }, 15000);

  it.skipIf(needsSecondConnection)("rechecks space permission in mutate even when the caller has no outer event transaction", async () => {
    // The editor's permission in the note's space drops to view while its write
    // waits on the event lock; the write must see the new permission.
    const id = await seedNode("authority");
    const space = await makeSpace(ws, `authority-${randomUUID()}`, [{ id: editor.id, permission: "edit" }]);
    await putInSpace(id, space);
    const locked = gate(), changePolicy = gate();
    const policyWrite = withEventTransaction(ws, async () => {
      locked.release();
      await changePolicy.promise;
      await q("UPDATE space_members SET permission='view' WHERE space_id=$1 AND actor_id=$2", [space, editor.id]);
    });
    await locked.promise;
    let pending: Promise<Response> | undefined;
    try {
      pending = mutate({ actor: editor, workspaceId: ws,
        authority: { kind: "node", nodeId: id, op: "write_node" },
        event: { type: "NODE_UPDATED", targetType: "node", targetId: id },
        apply: async () => { await seedQ("UPDATE content_nodes SET order_key='a73' WHERE id=$1", [id]); },
      }).then(() => new Response(null, { status: 200 }), error => {
        assert(error instanceof AuthorityError);
        return new Response(null, { status: 403 });
      });
      await waitingWriters(1);
    } finally { changePolicy.release(); }
    await policyWrite;
    const response = await pending!;
    assert.equal(response.status, 403);
    await assert.rejects(() => assertAuthority(editor, { kind: "node", nodeId: id, op: "write_node" }), AuthorityError);
    const row = (await q("SELECT order_key FROM content_nodes WHERE id=$1", [id])).rows[0];
    assert.equal(row.order_key, "a0");
    const fresh = await patch(id, { order_key: "a74" }, editor);
    assert.equal(fresh.status, 403);
    assert.equal((await q("SELECT count(*)::int AS n FROM domain_events WHERE target_id=$1 AND event_type='NODE_UPDATED'", [id])).rows[0].n, 0);
  }, 15000);

  it.skipIf(needsSecondConnection)("merges disjoint concurrent edits against the actual committed body", async () => {
    const base = "alpha\n\nmiddle\n\nomega\n";
    const first = base.replace("alpha", "alpha from A");
    const second = base.replace("omega", "omega from B");
    const id = await seedNode("merge", base);
    const locked = gate(), release = gate();
    const blocker = withEventTransaction(ws, async () => { locked.release(); await release.promise; });
    await locked.promise;
    let a: Promise<Response> | undefined, b: Promise<Response> | undefined;
    try {
      a = patch(id, { markdown: first, base_markdown: base });
      await waitingWriters(1);
      b = patch(id, { markdown: second, base_markdown: base });
      await waitingWriters(2);
    } finally { release.release(); }
    await blocker;
    const responses = await Promise.all([a!,b!]);
    assert.deepEqual(responses.map(r => r.status), [200,200]);
    await awaitAllDispatchers();
    const row = (await q("SELECT markdown FROM content_nodes WHERE id=$1", [id])).rows[0];
    assert.equal(row.markdown, first.replace("omega", "omega from B"));
    const conflicts = (await q("SELECT id FROM domain_events WHERE target_id=$1 AND event_type='BODY_CONFLICT'", [id])).rows;
    assert.equal(conflicts.length, 0);
    const control = await seedNode("sequential-merge", base);
    assert.equal((await patch(control, { markdown: first, base_markdown: base })).status, 200);
    assert.equal((await patch(control, { markdown: second, base_markdown: base })).status, 200);
    await awaitAllDispatchers();
    const sequential = (await q("SELECT markdown FROM content_nodes WHERE id=$1", [control])).rows[0].markdown;
    assert.equal(sequential, first.replace("omega", "omega from B"));
  }, 15000);

  it("keeps a conflicting edit, merges the rest, and records what it left out", async () => {
    const base = "清單\n買牛奶\n\n結尾\n";
    const id = await seedNode("conflict", base);
    assert.equal((await patch(id, { markdown: "清單\n買咖啡\n\n結尾\n", base_markdown: base })).status, 200);
    assert.equal((await patch(id, { markdown: "清單 v2\n買豆漿\n\n結尾\n", base_markdown: base })).status, 200);
    await awaitAllDispatchers();
    const row = (await q("SELECT markdown FROM content_nodes WHERE id=$1", [id])).rows[0];
    // "清單" and "買牛奶" are one changed run on the second writer's side, so
    // both lines are one conflict; the second writer's text is kept.
    assert.equal(row.markdown, "清單 v2\n買豆漿\n\n結尾\n");
    type Conflicts = { payload: { conflicts: Array<{ current: string }> } };
    const events = (await q<Conflicts>("SELECT payload FROM domain_events WHERE target_id=$1 AND event_type='BODY_CONFLICT'", [id])).rows;
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload.conflicts, [{
      base: "清單\n買牛奶\n", incoming: "清單 v2\n買豆漿\n", current: "清單\n買咖啡\n", before: "", after: "\n",
    }]);

    // Both rewrite the middle line (an addition at one point would merge, #672).
    const other = await seedNode("conflict-disjoint", "A\n\nB\n\nC\n");
    await patch(other, { markdown: "A\n\nQ1\n\nC1\n", base_markdown: "A\n\nB\n\nC\n" });
    await patch(other, { markdown: "A2\n\nQ2\n\nC\n", base_markdown: "A\n\nB\n\nC\n" });
    await awaitAllDispatchers();
    assert.equal((await q("SELECT markdown FROM content_nodes WHERE id=$1", [other])).rows[0].markdown, "A2\n\nQ2\n\nC1\n");
    const second = (await q<Conflicts>("SELECT payload FROM domain_events WHERE target_id=$1 AND event_type='BODY_CONFLICT'", [other])).rows;
    assert.deepEqual(second.map((e) => e.payload.conflicts.map((c) => c.current)), [["Q1\n"]]);
  }, 15000);

  it.skipIf(needsSecondConnection)("rejects the second of two moves that would create a parent cycle", async () => {
    const first = await seedNode("parent-a"), second = await seedNode("parent-b");
    const locked = gate(), release = gate();
    const blocker = withEventTransaction(ws, async () => { locked.release(); await release.promise; });
    await locked.promise;
    let a: Promise<Response> | undefined, b: Promise<Response> | undefined;
    try {
      a = patch(first, { parent_id: second });
      await waitingWriters(1);
      b = patch(second, { parent_id: first });
      await waitingWriters(2);
    } finally { release.release(); }
    await blocker;
    assert.deepEqual((await Promise.all([a!,b!])).map(r => r.status), [200,400]);
    const rows = (await q("SELECT id,parent_id FROM content_nodes WHERE id=ANY($1::uuid[])", [[first,second]])).rows;
    assert.equal(rows.find(n => n.id === first)?.parent_id, second);
    assert.equal(rows.find(n => n.id === second)?.parent_id, null);
  }, 15000);

  it.skipIf(needsSecondConnection)("keeps an empty page cursor so a later commit arrives on the next sync", async () => {
    const id = await seedNode("delta-gap");
    const cursor = Number((await q("SELECT COALESCE(MAX(id),0) AS id FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].id);
    const reached = gate(), release = gate();
    const original = db.q;
    let paused = false;
    const querySpy = vi.spyOn(db, "q").mockImplementation((sql, params) => {
      const pending = original(sql, params);
      if (!paused && /SELECT id, event_type, target_type, target_id, payload/.test(sql)) {
        paused = true;
        return Promise.resolve(pending).then(async result => {
          assert.equal(result.rows.length, 0);
          reached.release();
          await release.promise;
          return result;
        });
      }
      return pending;
    });
    let response: Response;
    try {
      const sync = app.request(`/api/sync?since=${cursor}`);
      await until(async () => paused, "sync event query intercepted");
      await reached.promise;
      await mutate({ actor: admin, workspaceId: ws, authority: { kind: "node", nodeId: id, op: "write_node" },
        event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { title: "delta-gap" } },
        apply: async () => { await seedQ("UPDATE content_nodes SET markdown='new synced content' WHERE id=$1", [id]); },
      });
      release.release();
      response = await sync;
    } finally { release.release(); querySpy.mockRestore(); }
    assert.equal(response!.status, 200);
    const first = await response!.json();
    const second = await (await app.request(`/api/sync?since=${first.last_event_id}`)).json();
    assert.equal(Number(first.last_event_id), cursor);
    assert(!first.nodes.upsert.some((n: { id: string }) => n.id === id));
    assert(second.nodes.upsert.some((n: { id: string }) => n.id === id));
  }, 15000);

  it("does not charge a superseding backup payload for an old terminal failure", async () => {
    const nodeId = randomUUID();
    const enqueue = (markdown: string) => withEventTransaction(ws, () => enqueueBackup({ workspaceId: ws, nodeId, markdown, message: "core review" }));
    await enqueue("v1");
    const id = (await q<{ id: string }>("SELECT id FROM outbox WHERE dedup_key=$1 AND status='pending'", [`git_commit:${nodeId}`])).rows[0].id;
    await q("UPDATE outbox SET attempts=2,max_attempts=3 WHERE id=$1", [id]);
    const performed: unknown[] = [];
    const result = await drainOutbox({ id, perform: async (_kind, payload) => {
      performed.push(String(payload.markdown));
      await enqueue("v2-new-save");
      throw new Error("Injected failure of v1's last attempt");
    } });
    const row = (await q("SELECT status,attempts,payload->>'markdown' AS markdown FROM outbox WHERE id=$1", [id])).rows[0];
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.deepEqual(result, { done: 0, retried: 0, dead: 0 });
    assert.equal(row.markdown, "v2-new-save");
    assert.deepEqual(performed, ["v1"]);
    const next = await drainOutbox({ id, perform: async (_kind, payload) => { performed.push(String(payload.markdown)); } });
    assert.deepEqual(next, { done: 1, retried: 0, dead: 0 });
    assert.deepEqual(performed, ["v1", "v2-new-save"]);
  }, 15000);

  it("does not back off a newer backup after an old retryable failure", async () => {
    const nodeId = randomUUID();
    const enqueue = (markdown: string) => withEventTransaction(ws, () => enqueueBackup({ workspaceId: ws, nodeId, markdown, message: "core review" }));
    await enqueue("v1");
    const id = (await q<{ id: string }>("SELECT id FROM outbox WHERE dedup_key=$1 AND status='pending'", [`git_commit:${nodeId}`])).rows[0].id;
    await q("UPDATE outbox SET attempts=0,max_attempts=3 WHERE id=$1", [id]);
    const performed: unknown[] = [];
    const result = await drainOutbox({ id, perform: async (_kind, payload) => {
      performed.push(String(payload.markdown));
      await enqueue("v2-new-save");
      throw new Error("Injected failure of v1's last attempt");
    } });
    const row = (await q("SELECT status,attempts,payload->>'markdown' AS markdown FROM outbox WHERE id=$1", [id])).rows[0];
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.deepEqual(result, { done: 0, retried: 0, dead: 0 });
    assert.equal(row.markdown, "v2-new-save");
    assert.deepEqual(performed, ["v1"]);
    const next = await drainOutbox({ id, perform: async (_kind, payload) => { performed.push(String(payload.markdown)); } });
    assert.deepEqual(next, { done: 1, retried: 0, dead: 0 });
    assert.deepEqual(performed, ["v1", "v2-new-save"]);
  }, 15000);


  it.skipIf(needsSecondConnection)("records the actual scalar predecessor so queued edits can be undone in order", async () => {
    const id = await seedNode("scalar-history");
    // Under a parent of its own: a restore gives back the earlier key only when no live sibling holds it (services/orderKeys.ts
    // keyForRestore; otherwise a fresh key just before that sibling), and the shared workspace's root is full of notes keyed "a0".
    await seedQ("UPDATE content_nodes SET parent_id=$2 WHERE id=$1", [id, await seedNode("scalar-history-parent")]);
    const locked = gate(), release = gate();
    const blocker = withEventTransaction(ws, async () => { locked.release(); await release.promise; });
    await locked.promise;
    let a: Promise<Response> | undefined, b: Promise<Response> | undefined;
    try {
      a = patch(id, { order_key: "a5" });
      await waitingWriters(1);
      b = patch(id, { order_key: "a9" });
      await waitingWriters(2);
    } finally { release.release(); }
    await blocker;
    assert.deepEqual((await Promise.all([a!, b!])).map(r => r.status), [200, 200]);
    // order_key, not hidden: only a tag can be hidden since D104.
    const history = (await q<{ id: string; tx_meta: { prev_field_values: { order_key: string } } }>(
      "SELECT id::text, tx_meta FROM domain_events WHERE target_id=$1 AND event_type='NODE_UPDATED' ORDER BY domain_events.id", [id],
    )).rows;
    assert.deepEqual(history.map(e => e.tx_meta.prev_field_values.order_key), ["a0", "a5"]);
    assert.equal("restored" in await restoreEvent(history[1].id, { workspaceId: ws, actor: admin }), true);
    assert.equal((await q("SELECT order_key FROM content_nodes WHERE id=$1", [id])).rows[0].order_key, "a5");
    assert.equal("restored" in await restoreEvent(history[0].id, { workspaceId: ws, actor: admin }), true);
    assert.equal((await q("SELECT order_key FROM content_nodes WHERE id=$1", [id])).rows[0].order_key, "a0");
  }, 15000);

  it.skipIf(needsSecondConnection)("agent title-only edits preserve a queued body edit and share durable save effects", async () => {
    const id = await seedNode("agent-body");
    const locked = gate(), release = gate();
    const blocker = withEventTransaction(ws, async () => { locked.release(); await release.promise; });
    await locked.promise;
    let a: Promise<Response> | undefined;
    let b: ReturnType<typeof agentUpdateNode.handler> | undefined;
    try {
      a = patch(id, { markdown: "new body from UI", base_markdown: "original" });
      await waitingWriters(1);
      b = agentUpdateNode.handler({ id, title: `Agent title ${stamp}` }, { actor: delegated, workspaceId: ws, dryRun: false });
      await waitingWriters(2);
    } finally { release.release(); }
    await blocker;
    assert.equal((await a!).status, 200);
    const result = (await b!) as { event_id: string };
    await awaitAllDispatchers();
    const node = (await q("SELECT markdown,title FROM content_nodes WHERE id=$1", [id])).rows[0];
    assert.equal(node.markdown, "new body from UI");
    assert.equal(node.title, `Agent title ${stamp}`);
    const evt = (await q("SELECT actor_type,tx_meta FROM domain_events WHERE id=$1", [result.event_id])).rows[0];
    assert.equal(evt.actor_type, "ai_agent");
    assert.equal((evt.tx_meta as { ui_context: string }).ui_context, "mcp.tool.updateNode");
    const effects = (await q("SELECT effect_kind, payload FROM outbox WHERE triggered_by_event_id=$1", [result.event_id])).rows;
    assert(effects.some(e => e.effect_kind === "git_commit" && (e.payload as { markdown: string }).markdown === "new body from UI"));
  }, 15000);

  it("ordinary PATCH cannot demote a class tag, even for the owner", async () => {
    const tag = await seedClassTag(ws, { name: `identity-${randomUUID()}-${stamp}` });
    created.push(tag.tagId);
    assert.equal((await patch(tag.tagId, { node_type: "content" }, admin)).status, 422);
    assert.equal((await patch(tag.tagId, { title: `editable tag description ${admin.id} ${stamp}` }, admin)).status, 200);
    assert.equal((await q("SELECT node_type FROM content_nodes WHERE id=$1", [tag.tagId])).rows[0].node_type, "class_tag");
  });

  it("a delegated token cannot change a tag definition at all", async () => {
    const tag = await seedClassTag(ws, { name: `identity-${randomUUID()}-${stamp}` });
    created.push(tag.tagId);
    assert.equal((await patch(tag.tagId, { node_type: "content" }, delegated)).status, 403);
    assert.equal((await patch(tag.tagId, { title: `agent tag rename ${stamp}` }, delegated)).status, 403);
    assert.equal((await q("SELECT node_type FROM content_nodes WHERE id=$1", [tag.tagId])).rows[0].node_type, "class_tag");
  });

  it.each(["class_tag", "content"])("legacy identity restore from %s requires the principal, including force", async currentType => {
    const targetType = currentType === "class_tag" ? "content" : "class_tag";
    const tag = await seedClassTag(ws, { name: `restore-identity-${randomUUID()}-${stamp}` });
    created.push(tag.tagId);
    const eventId = await withEventTransaction(ws, () => mutate({
      actor: admin, workspaceId: ws, authority: { kind: "principal_admin" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: tag.tagId,
        payload: { node_type: currentType }, txMeta: { prev_field_values: { node_type: targetType } } },
      apply: async ({ eventId }) => {
        // Fixture models legacy identity history; ordinary PATCH now rejects it.
        await seedQ("UPDATE content_nodes SET node_type=$2 WHERE id=$1", [tag.tagId, currentType]);
        return eventId;
      },
    }));
    const epoch = async () => Number((await q("SELECT membership_epoch FROM workspaces WHERE id=$1", [ws])).rows[0].membership_epoch);
    const beforeEpoch = await epoch();
    for (const actor of [editor, delegated]) {
      for (const force of [false, true]) {
        await assert.rejects(() => restoreEvent(eventId, { workspaceId: ws, actor, force }), AuthorityError);
      }
    }
    assert.equal(await epoch(), beforeEpoch);
    assert.equal((await q("SELECT node_type FROM content_nodes WHERE id=$1", [tag.tagId])).rows[0].node_type, currentType);
    const restored = await restoreEvent(eventId, { workspaceId: ws, actor: admin });
    assert.equal("restored" in restored, true);
    assert.equal((await q("SELECT node_type FROM content_nodes WHERE id=$1", [tag.tagId])).rows[0].node_type, targetType);
    assert.equal(await epoch(), beforeEpoch + 1);
  });

  it("keeps ordinary content type PATCH compatible for editors", async () => {
    const id = await seedNode("same-type");
    assert.equal((await patch(id, { node_type: "content", order_key: "a4" }, editor)).status, 200);
    assert.equal((await q("SELECT order_key FROM content_nodes WHERE id=$1", [id])).rows[0].order_key, "a4");
  });

  beforeAll(async () => {
    ws = await getWorkspaceId();
    for (const actor of [admin, editor, delegated]) Object.assign(actor, await persistActor(ws, actor));
  });
  afterEach(async () => { await awaitAllDispatchers(); });
  afterAll(async () => {
    await awaitAllDispatchers();
    // Only this suite's synthetic rows; break cycles even during the red run.
    await seedQ("UPDATE content_nodes SET parent_id=NULL WHERE id=ANY($1::uuid[])", [created]);
    await seedQ("DELETE FROM content_nodes WHERE id=ANY($1::uuid[])", [created]);
    await q("DELETE FROM outbox WHERE payload::text LIKE $1", [`%${stamp}%`]);
    await pool.end();
  });
});
