/** Historical diagnostic probes for the PRE-FIX 2026-09-13 core review.
 * These deliberately fail once the defects are fixed. Use
 * packages/backend/src/test/coreConsistency.integration.test.ts for regressions.
 * Run from the repo root with NODE_ENV=test and DATABASE_URL pointing to the
 * dedicated local onden_core_review_test DB: npx tsx this-file.mts.
 * Uses real routers/SQL; barriers only control interleaving. Outbox I/O is
 * injected, so no external backup/publish happens. Adds synthetic fixtures;
 * never deletes existing data. These assert observed bugs, not desired behavior,
 * and deliberately are NOT included in the regular regression suite.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { pool, q, getWorkspaceId } from "../../packages/backend/src/db.ts";
import { apiOnError } from "../../packages/backend/src/httpError.ts";
import { mutate } from "../../packages/backend/src/spine/mutate.ts";
import { assertAuthority, AuthorityError } from "../../packages/backend/src/spine/authority.ts";
import { withEventTransaction } from "../../packages/backend/src/spine/eventTransaction.ts";
import { enqueueBackup, drainOutbox } from "../../packages/backend/src/services/outbox.ts";
import { awaitAllDispatchers } from "../../packages/backend/src/services/dispatcherQueue.ts";
import { seedClassTag } from "../../packages/backend/src/test/helpers/seedClassTag.ts";
import nodesRouter from "../../packages/backend/src/routes/nodes.ts";
import syncRouter from "../../packages/backend/src/routes/sync.ts";
import type { ActorCtx } from "../../packages/backend/src/types.ts";

const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert.equal(process.env.NODE_ENV, "test");
assert.equal(database.pathname, "/onden_core_review_test");
assert(["127.0.0.1", "localhost"].includes(database.hostname));
const admin: ActorCtx = { id: "core-review-admin", name: "Review", type: "human", role: "admin" };
const editor: ActorCtx = { ...admin, id: "core-review-editor", role: "editor" };
const ws = await getWorkspaceId();
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
const patch = (id: string, body: Record<string, unknown>, actor = admin) => appFor(actor).request(`/api/nodes/${id}`, {
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
  await q(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
    VALUES($1,$2,'manual','content',$3,$4,$5)`, [id,ws,label,`${label}-${stamp}-${id}`,markdown]);
  return id;
}
function report(id: string, evidence: unknown) {
  console.log(JSON.stringify({ probe: id, reproduced: true, evidence }));
}

try {
  // 1. Authorized while waiting, then writes AFTER a restrictive policy commits.
  {
    const id = await seedNode("authority");
    const tag = await seedClassTag(ws, { name: `policy-${stamp}`, policy: { operations: { write_node: "editor" } } });
    await q("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [id,tag.tagId]);
    const locked = gate(), changePolicy = gate();
    const policyWrite = withEventTransaction(ws, async () => {
      locked.release();
      await changePolicy.promise;
      await mutate({
        actor: admin, workspaceId: ws, authority: { kind: "principal_admin" },
        event: { type: "TAG_SCHEMA_UPDATED", targetType: "tag", targetId: tag.tagId, payload: { policy: { operations: { write_node: "admin" } } } },
        apply: async () => { await q(`UPDATE content_nodes SET tag_schema=jsonb_set(tag_schema,'{policy}', $2::jsonb) WHERE id=$1`,
          [tag.tagId, JSON.stringify({ operations: { write_node: "admin" } })]); },
      });
    });
    await locked.promise;
    let pending: Promise<Response> | undefined;
    try {
      pending = patch(id, { sort_order: 73 }, editor);
      await waitingWriters(1);
    } finally { changePolicy.release(); }
    await policyWrite;
    const response = await pending!;
    assert.equal(response.status, 200);
    await assert.rejects(() => assertAuthority(editor, { kind: "node", nodeId: id, op: "write_node" }), AuthorityError);
    const row = (await q("SELECT sort_order FROM content_nodes WHERE id=$1", [id])).rows[0];
    assert.equal(row.sort_order, 73);
    const fresh = await patch(id, { sort_order: 74 }, editor);
    assert.equal(fresh.status, 403);
    report("C1-authority-before-lock", { http: response.status, savedSortOrder: row.sort_order, currentAuthority: "denied", freshRequest: fresh.status });
  }

  // 2. Two non-overlapping body patches use the same stale pre-lock baseline.
  {
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
    assert.equal(row.markdown, second);
    const conflicts = (await q("SELECT id FROM domain_events WHERE target_id=$1 AND event_type='BODY_CONFLICT'", [id])).rows;
    assert.equal(conflicts.length, 0);
    const control = await seedNode("sequential-merge", base);
    assert.equal((await patch(control, { markdown: first, base_markdown: base })).status, 200);
    assert.equal((await patch(control, { markdown: second, base_markdown: base })).status, 200);
    await awaitAllDispatchers();
    const sequential = (await q("SELECT markdown FROM content_nodes WHERE id=$1", [control])).rows[0].markdown;
    assert.equal(sequential, first.replace("omega", "omega from B"));
    report("C2-stale-merge-baseline", { http: [200,200], finalBody: row.markdown, lostNonOverlappingEdit: "alpha from A", conflictEvents: conflicts.length, sequentialControl: sequential });
  }

  // The same pre-lock state validation also allows two valid moves to form a cycle.
  {
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
    assert.deepEqual((await Promise.all([a!,b!])).map(r => r.status), [200,200]);
    const rows = (await q("SELECT id,parent_id FROM content_nodes WHERE id=ANY($1::uuid[])", [[first,second]])).rows;
    assert.equal(rows.find(n => n.id === first)?.parent_id, second);
    assert.equal(rows.find(n => n.id === second)?.parent_id, first);
    report("C2b-parent-cycle", { http: [200,200], cycle: "A.parent=B and B.parent=A" });
  }

  // 3. Pause AFTER the real empty event query; commit before the later MAX read.
  {
    const id = await seedNode("delta-gap");
    const cursor = Number((await q("SELECT COALESCE(MAX(id),0) AS id FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].id);
    const reached = gate(), release = gate();
    const original = pool.query;
    let paused = false;
    pool.query = function (...args: unknown[]) {
      const pending = Reflect.apply(original, pool, args);
      const sql = String(args[0]);
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
    } as typeof pool.query;
    let response: Response;
    try {
      const sync = app.request(`/api/sync?since=${cursor}`);
      await until(async () => paused, "sync event query intercepted");
      await reached.promise;
      await mutate({ actor: admin, workspaceId: ws, authority: { kind: "node", nodeId: id, op: "write_node" },
        event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { title: "delta-gap" } },
        apply: async () => { await q("UPDATE content_nodes SET markdown='new synced content' WHERE id=$1", [id]); },
      });
      release.release();
      response = await sync;
    } finally { release.release(); pool.query = original; }
    assert.equal(response!.status, 200);
    const first = await response!.json();
    const second = await (await app.request(`/api/sync?since=${first.last_event_id}`)).json();
    assert(Number(first.last_event_id) > cursor);
    assert(!first.nodes.upsert.some((n: { id: string }) => n.id === id));
    assert(!second.nodes.upsert.some((n: { id: string }) => n.id === id));
    report("C3-empty-delta-cursor", { before: cursor, after: first.last_event_id, nodeId: id, deliveredFirst: false, deliveredNext: false });
  }

  // 4. A failed old attempt exhausts retries of a NEW payload coalesced meanwhile.
  {
    const slug = `outbox-${stamp}`;
    const enqueue = (markdown: string) => withEventTransaction(ws, () => enqueueBackup({ workspaceId: ws, slug, markdown, message: "core review" }));
    await enqueue("v1");
    const id = (await q("SELECT id FROM outbox WHERE dedup_key=$1 AND status='pending'", [`git_commit:${slug}`])).rows[0].id;
    await q("UPDATE outbox SET attempts=2,max_attempts=3 WHERE id=$1", [id]);
    const performed: unknown[] = [];
    const result = await drainOutbox({ id, perform: async (_kind, payload) => {
      performed.push(payload.markdown);
      await enqueue("v2-new-save");
      throw new Error("Injected failure of v1's last attempt");
    } });
    const row = (await q("SELECT status,attempts,payload->>'markdown' AS markdown FROM outbox WHERE id=$1", [id])).rows[0];
    assert.equal(row.status, "dead");
    assert.equal(row.markdown, "v2-new-save");
    assert.deepEqual(performed, ["v1"]);
    report("C4-outbox-stale-failure", { result, row, performed });
  }

  // 5. A generic node patch can turn a policy tag into content, disabling its ACL.
  {
    const id = await seedNode("type-policy");
    const tag = await seedClassTag(ws, { name: `type-policy-${stamp}`, policy: { operations: { read: "admin", write_node: "admin" } } });
    await q("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [id,tag.tagId]);
    const read = () => appFor(editor).request(`/api/nodes/${id}`);
    const epoch = async () => Number((await q("SELECT membership_epoch FROM workspaces WHERE id=$1", [ws])).rows[0].membership_epoch);
    const before = await read();
    assert.equal(before.status, 403);
    await assert.rejects(() => assertAuthority(editor, { kind: "node", nodeId: id, op: "write_node" }), AuthorityError);
    const oldEpoch = await epoch();
    const changed = await patch(tag.tagId, { node_type: "content" }, editor);
    assert.equal(changed.status, 200);
    const after = await read();
    assert.equal(after.status, 200);
    await assertAuthority(editor, { kind: "node", nodeId: id, op: "write_node" });
    const newEpoch = await epoch();
    assert.equal(newEpoch, oldEpoch);
    report("C5-node-type-policy-bypass", { beforeRead: before.status, nodeTypePatch: changed.status, afterRead: after.status, policyEpochBefore: oldEpoch, policyEpochAfter: newEpoch });
  }
} finally {
  await awaitAllDispatchers();
  await pool.end();
}
