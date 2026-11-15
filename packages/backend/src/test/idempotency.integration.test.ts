// Idempotent replay shield (offline-queue follow-up to audit #4): a write
// carrying an Idempotency-Key applies once; replays short-circuit with
// {deduped:true} and change NOTHING — the cure for lost-response retries and
// a second tab/device draining the same queue.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { q, getWorkspaceId, withTransaction } from "../db.js";
import { mutate, requireActor, withIdempotencyKey } from "../spine/mutate.js";
import { retryOnSlugConflict } from "../services/nodes.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const NATIVE = { origin: "http://localhost" };
// The native System actor has no personal space and may sit in several
// spaces, so a top-level note names its space (services/spaces.ts newNoteSpace).
async function req(path: string, init: RequestInit & { json?: unknown; idem?: string } = {}): Promise<Response> {
  const { json: rawJson, idem, ...rest } = init;
  const json = path === "/api/nodes" && rest.method === "POST" && rawJson && typeof rawJson === "object"
    && !("space_id" in rawJson)
    ? { ...rawJson, space_id: (await q<{ id: string }>(
        `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [await getWorkspaceId()])).rows[0]!.id }
    : rawJson;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  if (idem) headers["Idempotency-Key"] = idem;
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

describe.skipIf(!isTestDb)("idempotency keys (offline replay shield)", () => {
  let nodeId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    await getWorkspaceId();
    nodeId = ((await (await req("/api/nodes", { method: "POST", json: { title: `idem ${Date.now()}`, markdown: "x" } })).json()) as { id: string }).id;
  });

  it("first application succeeds; the replay dedupes and changes nothing", async () => {
    const key = crypto.randomUUID();
    const first = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: "applied-once" }, idem: key });
    expect(first.status).toBeLessThan(300);

    // replay with the SAME key but a DIFFERENT body — must not apply
    const replay = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: "replayed-evil" }, idem: key });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { deduped?: boolean }).deduped).toBe(true);

    const row = await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [nodeId]);
    expect(row.rows[0]!.title).toBe("applied-once");
  });

  it("a fresh key applies normally; requests without a key are untouched", async () => {
    const second = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: "second-key" }, idem: crypto.randomUUID() });
    expect(second.status).toBeLessThan(300);
    const noKey = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: "no-key" } });
    expect(noKey.status).toBeLessThan(300);
    const row = await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [nodeId]);
    expect(row.rows[0]!.title).toBe("no-key");
  });

  // Found by the sync simulator: removing a property that is not there writes nothing, so it claimed no key, and the retry of
  // that delete (lost reply) removed the value another device had set in between.
  it("removing a property that is not there still spends the key: its retry does not remove a newer value", async () => {
    const path = `/api/nodes/${nodeId}/attributes/sim_idem`;
    const key = crypto.randomUUID();
    expect((await req(path, { method: "DELETE", idem: key })).status).toBe(200); // nothing to remove
    expect((await req(path, { method: "PUT", json: { value: "newer" }, idem: crypto.randomUUID() })).status).toBe(200);
    const retry = await req(path, { method: "DELETE", idem: key });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { deduped?: boolean }).deduped).toBe(true);
    const stored = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'sim_idem'`, [nodeId]);
    expect(stored.rows[0]?.value).toBe("newer");
  });

  it("malformed keys are refused, GETs ignore the header", async () => {
    const bad = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: "x" }, idem: "not-a-uuid" });
    expect(bad.status).toBe(400);
    const get = await req(`/api/bootstrap`, { idem: crypto.randomUUID() });
    expect(get.status).toBe(200);
  });
});

// ── Failure-replay + concurrency (the silent-data-loss regression) ──────────
//
// The bug this pins: the key claim used to auto-commit OUTSIDE the route's
// transaction. A first attempt whose handler 5xxed rolled back its write but
// left the key committed — so a retry short-circuited to {deduped:true} and
// the mutation was lost forever. The fix moves the claim INSIDE spine
// mutate()'s transaction, so the key persists IFF the write commits.
//
// We can't make a real route 5xx deterministically mid-transaction, so we
// mount a tiny harness route that drives spine mutate() directly and can be
// told to throw inside apply() — exercising the exact tx boundary the real
// routes share. withIdempotencyKey() reproduces what index.ts's middleware
// now does (make the header's key ambient for the spine).
describe.skipIf(!isTestDb)("idempotency claim shares the route transaction", () => {
  let actor: ActorCtx;
  let nodeId = "";
  // When set, the harness route's apply() throws AFTER the key is claimed but
  // before commit — simulating a handler 5xx mid-transaction.
  let failNext = false;
  // When set, the slug-retry harness's FIRST apply() throws a slug-conflict
  // (23505 on the slug index) so retryOnSlugConflict re-runs the mutate — the
  // exact shape of POST /api/nodes losing the uniqueSlug race (H9).
  let failSlugOnce = false;

  const harness = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  harness.onError(apiOnError);
  harness.use("*", async (c, next) => {
    c.set("actor", actor);
    // Mirror index.ts: validate + make the Idempotency-Key ambient for mutate().
    const key = c.req.header("idempotency-key");
    if (key) return withIdempotencyKey(key, next);
    return next();
  });
  // A spine write guarded by the ambient idempotency key. apply() bumps the
  // node title so we can assert whether the mutation actually landed.
  harness.post("/harness/bump/:id", async (c) => {
    const id = c.req.param("id");
    const a = requireActor(c.get("actor"));
    const workspaceId = await getWorkspaceId();
    await mutate({
      actor: a,
      workspaceId,
      authority: { kind: "node", nodeId: id, op: "write_node" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { title: "bumped" } },
      apply: async () => {
        await seedQ(`UPDATE content_nodes SET title = title || '!' WHERE id = $1`, [id]);
        if (failNext) throw new Error("injected handler failure (post-claim, pre-commit)");
      },
    });
    return c.json({ ok: true });
  });

  // TWO top-level mutate() calls in ONE request — the shape of POST /tasks
  // (a first mutate, THEN createTaskNode). The idem key guards the request, so
  // both must apply; the regression was the 2nd self-conflicting on the 1st's
  // claim → IdempotentReplay → 200 {deduped:true}, silently dropping the 2nd.
  harness.post("/harness/two/:id", async (c) => {
    const id = c.req.param("id");
    const a = requireActor(c.get("actor"));
    const workspaceId = await getWorkspaceId();
    const oneBump = (): Promise<void> => mutate({
      actor: a,
      workspaceId,
      authority: { kind: "node", nodeId: id, op: "write_node" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { title: "bumped" } },
      apply: async () => { await seedQ(`UPDATE content_nodes SET title = title || '!' WHERE id = $1`, [id]); },
    });
    await oneBump(); // claims the request's idem key
    await oneBump(); // must NOT dedupe-throw on the same key
    return c.json({ ok: true });
  });

  // H10: two top-level mutates that must commit together. POST /tasks used to do
  // a first mutate THEN createTaskNode(). When set, the SECOND mutate throws —
  // simulating createTaskNode failing after the first mutate committed. We mount
  // both shapes to pin exactly what the route's withTransaction wrap buys:
  //   • split  — each mutate in its OWN tx (the pre-fix route): the first
  //              commits the key, the retry then dedupes → the task is lost.
  //   • atomic — both mutates share ONE tx (the fix): a failure rolls the key
  //              back with both writes, so the retry genuinely re-runs.
  let failSecond = false;
  const bumpOnce = (a: ActorCtx, ws: string, id: string, fail = false): Promise<void> =>
    mutate({
      actor: a,
      workspaceId: ws,
      authority: { kind: "node", nodeId: id, op: "write_node" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { title: "bumped" } },
      apply: async () => {
        await seedQ(`UPDATE content_nodes SET title = title || '!' WHERE id = $1`, [id]);
        if (fail) throw new Error("second-mutate failure (post first-mutate commit)");
      },
    });
  harness.post("/harness/twotx-split/:id", async (c) => {
    const id = c.req.param("id");
    const a = requireActor(c.get("actor"));
    const workspaceId = await getWorkspaceId();
    await bumpOnce(a, workspaceId, id); // own tx — commits the key + write 1
    await bumpOnce(a, workspaceId, id, failSecond); // own tx — may throw
    return c.json({ ok: true });
  });
  harness.post("/harness/twotx-atomic/:id", async (c) => {
    const id = c.req.param("id");
    const a = requireActor(c.get("actor"));
    const workspaceId = await getWorkspaceId();
    await withTransaction(async () => {
      await bumpOnce(a, workspaceId, id); // shared tx — claims the key
      await bumpOnce(a, workspaceId, id, failSecond); // shared tx — may throw → all rolls back
    });
    return c.json({ ok: true });
  });

  // retryOnSlugConflict wrapping a SINGLE idem-guarded mutate — the shape of
  // routes/nodes.ts:170 and agentTools/createNode.ts. The first apply() loses
  // the slug race (23505) and rolls back (claim + write); the retry must RE-RUN
  // and persist the key, or a later cross-request replay duplicates (H9).
  harness.post("/harness/slugretry/:id", async (c) => {
    const id = c.req.param("id");
    const a = requireActor(c.get("actor"));
    const workspaceId = await getWorkspaceId();
    await retryOnSlugConflict(async () =>
      mutate({
        actor: a,
        workspaceId,
        authority: { kind: "node", nodeId: id, op: "write_node" },
        event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { title: "bumped" } },
        apply: async () => {
          await seedQ(`UPDATE content_nodes SET title = title || '!' WHERE id = $1`, [id]);
          if (failSlugOnce) {
            failSlugOnce = false;
            throw Object.assign(new Error("duplicate key value"), {
              code: "23505",
              constraint: "content_nodes_space_slug_uq",
            });
          }
        },
      }),
    );
    return c.json({ ok: true });
  });

  const bump = (id: string, idem?: string): Promise<Response> =>
    Promise.resolve(harness.request(`/harness/bump/${id}`, {
      method: "POST",
      headers: idem ? { "Idempotency-Key": idem } : {},
    }));
  const two = (id: string, idem?: string): Promise<Response> =>
    Promise.resolve(harness.request(`/harness/two/${id}`, {
      method: "POST",
      headers: idem ? { "Idempotency-Key": idem } : {},
    }));
  const slugRetry = (id: string, idem?: string): Promise<Response> =>
    Promise.resolve(harness.request(`/harness/slugretry/${id}`, {
      method: "POST",
      headers: idem ? { "Idempotency-Key": idem } : {},
    }));
  const twoTx = (shape: "split" | "atomic", id: string, idem?: string): Promise<Response> =>
    Promise.resolve(harness.request(`/harness/twotx-${shape}/${id}`, {
      method: "POST",
      headers: idem ? { "Idempotency-Key": idem } : {},
    }));

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const workspaceId = await getWorkspaceId();
    // This workspace's System (the native requests' actor): the shared DB
    // holds other workspaces, each with a System of its own.
    const sys = await q<{ id: string; name: string; type: ActorCtx["type"] }>(
      `SELECT id, name, type FROM actors WHERE workspace_id = $1 AND external_id = 'system' LIMIT 1`,
      [workspaceId],
    );
    actor = sys.rows[0]!;
    nodeId = ((await (await req("/api/nodes", { method: "POST", json: { title: "claim-tx", markdown: "x" } })).json()) as { id: string }).id;
  });

  it("a failed first attempt rolls the key back, so a replay RE-RUNS and succeeds", async () => {
    const key = crypto.randomUUID();
    const before = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;

    // First attempt: handler throws after the claim → whole tx (claim + write)
    // rolls back.
    failNext = true;
    const first = await bump(nodeId, key);
    expect(first.status).toBeGreaterThanOrEqual(500);

    // The mutation did NOT land …
    const mid = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(mid).toBe(before);
    // … and the key was NOT persisted (rolled back with the tx).
    const keyRow = await q(`SELECT 1 FROM idempotency_keys WHERE key=$1`, [key]);
    expect(keyRow.rowCount).toBe(0);

    // Replay with the SAME key now genuinely re-runs (not deduped) and succeeds.
    failNext = false;
    const replay = await bump(nodeId, key);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { ok?: boolean; deduped?: boolean })).toEqual({ ok: true });
    const after = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(after).toBe(before + "!");

    // A THIRD attempt with the same key (now that the original committed) dedupes.
    const third = await bump(nodeId, key);
    expect(third.status).toBe(200);
    expect(((await third.json()) as { deduped?: boolean }).deduped).toBe(true);
    const finalTitle = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(finalTitle).toBe(after); // unchanged by the dedupe
  });

  it("a slug-conflict retry (same request, same key) re-claims the key, so a later replay dedupes — not duplicate (H9)", async () => {
    const key = crypto.randomUUID();
    const before = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;

    // First mutate attempt loses the slug race AFTER claiming the key → its tx
    // (claim + write) rolls back; retryOnSlugConflict re-runs the mutate in a
    // fresh tx, which must re-claim the now-vanished key and commit it.
    failSlugOnce = true;
    const res = await slugRetry(nodeId, key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Exactly one '!' survived: the rolled-back attempt's write is gone, the
    // retry's write committed.
    const after = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(after).toBe(before + "!");

    // The key WAS persisted by the committed retry (the regression skipped the
    // re-claim because the in-memory `claimed` flag survived the rollback).
    const keyRow = await q(`SELECT 1 FROM idempotency_keys WHERE key=$1`, [key]);
    expect(keyRow.rowCount).toBe(1);

    // A cross-request replay with the same key now DEDUPES (the bug let it
    // re-run → a duplicate write, appending a second '!').
    failSlugOnce = false;
    const replay = await slugRetry(nodeId, key);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { deduped?: boolean }).deduped).toBe(true);
    const final = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(final).toBe(before + "!"); // unchanged by the dedupe — no duplicate
  });

  it("partial commit across two SEPARATE-tx mutates loses the retry's write — the H10 bug the route's wrap prevents", async () => {
    const key = crypto.randomUUID();
    const before = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;

    // First attempt: mutate 1 commits its OWN tx (key + one '!'), mutate 2 throws.
    failSecond = true;
    const first = await twoTx("split", nodeId, key);
    expect(first.status).toBeGreaterThanOrEqual(500);
    // The key + the first write COMMITTED independently of the failed second.
    const mid = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(mid).toBe(before + "!");
    expect((await q(`SELECT 1 FROM idempotency_keys WHERE key=$1`, [key])).rowCount).toBe(1);

    // Retry: the committed key dedupes the whole request — the second write
    // (the "task") is NEVER created. Silent data loss.
    failSecond = false;
    const retry = await twoTx("split", nodeId, key);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { deduped?: boolean }).deduped).toBe(true);
    const after = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(after).toBe(before + "!"); // only mutate 1 ever landed — the bug
  });

  it("partial commit across two SHARED-tx mutates rolls the key back, so the retry re-runs BOTH — the H10 fix", async () => {
    const key = crypto.randomUUID();
    const before = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;

    // First attempt: mutate 2 throws → the shared tx rolls back mutate 1, the
    // key, and everything else.
    failSecond = true;
    const first = await twoTx("atomic", nodeId, key);
    expect(first.status).toBeGreaterThanOrEqual(500);
    const mid = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(mid).toBe(before); // nothing committed
    expect((await q(`SELECT 1 FROM idempotency_keys WHERE key=$1`, [key])).rowCount).toBe(0); // key rolled back

    // Retry: the key never persisted, so the request genuinely re-runs and BOTH
    // writes land atomically.
    failSecond = false;
    const retry = await twoTx("atomic", nodeId, key);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    const after = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(after).toBe(before + "!!"); // both mutates landed — no loss

    // A genuine replay now dedupes (the committed key).
    const replay = await twoTx("atomic", nodeId, key);
    expect(((await replay.json()) as { deduped?: boolean }).deduped).toBe(true);
    const final = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(final).toBe(before + "!!"); // unchanged by the dedupe
  });

  it("POST /api/nodes/:id/tasks (createTaskNode) is idempotent end-to-end — replay makes no second task", async () => {
    const key = crypto.randomUUID();
    const r1 = await req(`/api/nodes/${nodeId}/tasks`, { method: "POST", json: { title: "do-the-thing" }, idem: key });
    expect(r1.status).toBe(201);
    const created = (await r1.json()) as { id: string };

    // Replay the whole request: the first sub-mutate hits the committed key and
    // short-circuits the request (the wrap means the key committed WITH the
    // task, so dedupe is safe — no half-done state).
    const r2 = await req(`/api/nodes/${nodeId}/tasks`, { method: "POST", json: { title: "do-the-thing" }, idem: key });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { deduped?: boolean }).deduped).toBe(true);

    // Exactly ONE task child was created under the host.
    const count = await q<{ n: string }>(
      `SELECT count(*) AS n FROM content_nodes WHERE parent_id=$1 AND title='do-the-thing' AND deleted_at IS NULL`,
      [nodeId],
    );
    expect(count.rows[0]!.n).toBe("1");
    expect(created.id).toBeTruthy();
  });

  it("two top-level mutates in ONE request (same ambient key) BOTH apply — not deduped", async () => {
    failNext = false;
    const key = crypto.randomUUID();
    const before = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;

    const res = await two(nodeId, key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true }); // NOT {deduped:true}
    const after = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(after).toBe(before + "!!"); // BOTH mutates landed (regression appended only one)

    // A genuine replay of the WHOLE request still dedupes — the request's first
    // mutate hits the committed key and short-circuits; nothing applies twice.
    const replay = await two(nodeId, key);
    expect(((await replay.json()) as { deduped?: boolean }).deduped).toBe(true);
    const final = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(final).toBe(before + "!!"); // unchanged by the dedupe
  });

  it("two concurrent identical-key requests apply EXACTLY once", async () => {
    failNext = false;
    const key = crypto.randomUUID();
    const start = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;

    // Fire both before either resolves. They serialize on the (key) PK row lock:
    // one wins and commits the claim+write; the other blocks, then sees the
    // committed key → dedupes. Exactly one '!' is appended.
    const [a, b] = await Promise.all([bump(nodeId, key), bump(nodeId, key)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 200]);
    const bodies = await Promise.all([a.json(), b.json()]);
    const deduped = bodies.filter((x) => (x as { deduped?: boolean }).deduped === true);
    const applied = bodies.filter((x) => (x as { ok?: boolean }).ok === true);
    expect(deduped).toHaveLength(1);
    expect(applied).toHaveLength(1);

    const end = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [nodeId])).rows[0]!.title;
    expect(end).toBe(start + "!"); // applied exactly once, not twice
  });
});

// A retry after a lost reply is acknowledged by the replay shield in app.ts BEFORE the route's own state
// checks (note exists? already live?) can refuse it with 404/409.
describe.skipIf(!isTestDb)("replay shield answers a committed key before route state checks", () => {
  const create = async (): Promise<string> =>
    ((await (await req("/api/nodes", { method: "POST", json: { title: `shield ${crypto.randomUUID()}`, markdown: "x" } })).json()) as { id: string }).id;

  it("delete retried with the same key → 200 deduped (not 404); undelete likewise (not 409)", async () => {
    const id = await create();
    const delKey = crypto.randomUUID();
    expect((await req(`/api/nodes/${id}`, { method: "DELETE", idem: delKey })).status).toBeLessThan(300);
    const delRetry = await req(`/api/nodes/${id}`, { method: "DELETE", idem: delKey });
    expect(delRetry.status).toBe(200);
    expect(await delRetry.json()).toEqual({ deduped: true });

    const undoKey = crypto.randomUUID();
    expect((await req(`/api/nodes/${id}/undelete`, { method: "POST", idem: undoKey })).status).toBeLessThan(300);
    const undoRetry = await req(`/api/nodes/${id}/undelete`, { method: "POST", idem: undoKey });
    expect(undoRetry.status).toBe(200);
    expect(await undoRetry.json()).toEqual({ deduped: true });
  });

  it("a tag removal that changed nothing still claims its key: the retry after the note is deleted → 200 deduped", async () => {
    const id = await create();
    const tagId = ((await (await req("/api/tags", { method: "POST", json: { name: `shield-tag-${crypto.randomUUID()}` } })).json()) as { id: string }).id;
    const key = crypto.randomUUID();
    const first = await req(`/api/nodes/${id}/tags/${tagId}`, { method: "DELETE", idem: key });
    expect(await first.json()).toEqual({ ok: true, noop: true });
    expect((await req(`/api/nodes/${id}`, { method: "DELETE" })).status).toBeLessThan(300);
    const retry = await req(`/api/nodes/${id}/tags/${tagId}`, { method: "DELETE", idem: key });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deduped: true });
  });

  it("without a key (or with a fresh key) the route's own refusal is unchanged", async () => {
    const id = await create();
    expect((await req(`/api/nodes/${id}`, { method: "DELETE" })).status).toBeLessThan(300);
    expect((await req(`/api/nodes/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await req(`/api/nodes/${id}`, { method: "DELETE", idem: crypto.randomUUID() })).status).toBe(404);
  });

  it("a key committed in ANOTHER workspace is not acknowledged by the shield (same as an unknown key)", async () => {
    const id = await create();
    expect((await req(`/api/nodes/${id}`, { method: "DELETE" })).status).toBeLessThan(300);
    const otherWs = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Other', $1) RETURNING id`, [`other-${crypto.randomUUID()}`])).rows[0]!.id;
    const foreignKey = crypto.randomUUID();
    await q(`INSERT INTO idempotency_keys (key, workspace_id) VALUES ($1, $2)`, [foreignKey, otherWs]);
    // The note is already gone: an own-workspace key would be acknowledged (200); a foreign one gets the route's 404.
    expect((await req(`/api/nodes/${id}`, { method: "DELETE", idem: foreignKey })).status).toBe(404);
  });
});
