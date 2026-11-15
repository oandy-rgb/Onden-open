// The client's online writes retry a lost response with the same
// Idempotency-Key and expect the server to apply it once. Publishing used to
// take no claim (its snapshot is written with event(), not mutate()): a retry
// stored a second snapshot, a second PUBLISH_SNAPSHOT_CREATED and a second
// push.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import publishRouter from "../modules/website/routes.js";
import { withIdempotencyKey } from "../spine/mutate.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let owner: ActorCtx = { id: "pr-owner", name: "Owner", role: "admin", type: "human" };

/** One request carrying `key` as its Idempotency-Key (index.ts makes it
 *  ambient the same way). */
function call(method: string, path: string, body: unknown, key: string) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", owner); await withIdempotencyKey(key, next); });
  app.route("/api", publishRouter);
  return app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** The hash of what a publish would store now: the publish route refuses one without it. */
const previewHash = async () =>
  ((await (await call("POST", "/api/publish/preview", { title: "Replay site" }, randomUUID())).json()) as { hash: string }).hash;
const count = async (sql: string) => (await db.q(sql, [ws])).rowCount ?? 0;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("publishing under a replayed Idempotency-Key", () => {
  // A workspace per test: the counts below are of this test's own publishes.
  beforeEach(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Publish replay',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await persistActor(ws, { ...owner, id: "pr-owner" });
  });

  it("a publish retried with the same key is deduped: one snapshot, one event, one push", async () => {
    const key = randomUUID();
    const body = { title: "Replay site", preview_hash: await previewHash() };
    const first = await call("POST", "/api/publish", body, key);
    expect(first.status).toBe(201);
    const replay = await call("POST", "/api/publish", body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ deduped: true });

    expect(await count(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`)).toBe(1);
    expect(await count(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'PUBLISH_SNAPSHOT_CREATED'`)).toBe(1);
    expect(await count(`SELECT 1 FROM outbox WHERE workspace_id = $1 AND effect_kind = 'pages_push'`)).toBe(1);

    // A new key is a new publish.
    expect((await call("POST", "/api/publish", body, randomUUID())).status).toBe(201);
    expect(await count(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`)).toBe(2);
  });

  it("a publish that fails releases its key: the retry publishes", async () => {
    const key = randomUUID();
    const stale = await call("POST", "/api/publish", { title: "Replay site", preview_hash: "0".repeat(64) }, key);
    expect(stale.status).toBe(409);
    const before = await count(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`);
    expect((await call("POST", "/api/publish", { title: "Replay site", preview_hash: await previewHash() }, key)).status).toBe(201);
    expect(await count(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`)).toBe(before + 1);
  });
});
