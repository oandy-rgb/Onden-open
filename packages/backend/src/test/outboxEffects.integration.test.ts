// Real PostgreSQL: outbox effect kinds are registered (core at load, modules via
// mountModules), so the core never names a module. An intent whose module is
// absent waits instead of dying, and the inbox will not approve one.
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import inboxRouter from "../routes/inbox.js";
import {
  drainOutbox, enqueueEffect, outboxEffectInstalled, registerOutboxEffect, type OutboxEffect,
} from "../services/outbox.js";
import { mountModules, type ModuleApp, type ModuleDefinition } from "../modules/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let admin: ActorCtx = { id: "outbox-admin", name: "Test", role: "admin", type: "human" };

type Row = { status: string; attempts: number; last_error: string | null; deferred: boolean };
async function row(id: string): Promise<Row> {
  return (await db.q<Row>(
    `SELECT status, attempts, last_error, next_attempt_at > now() + interval '10 minutes' AS deferred
       FROM outbox WHERE id = $1::bigint`, [id],
  )).rows[0];
}
const effect = (kind: string, performed: unknown[] = []): OutboxEffect<{ value: string }> => ({
  kind,
  parse: (p) => ({ value: String(p.value) }),
  perform: async (p) => { performed.push(p.value); },
});

describe("outbox effect registry (unit)", () => {
  it("re-registering the same effect is a no-op; a different one for the kind throws", () => {
    const kind = `probe_${randomUUID()}`;
    const first = effect(kind);
    registerOutboxEffect(first);
    expect(() => registerOutboxEffect(first)).not.toThrow();
    expect(() => registerOutboxEffect(effect(kind))).toThrow(/already registered/);
  });

  it("core kinds are installed; an unknown kind has nothing to perform it", () => {
    expect(outboxEffectInstalled("tag_pack")).toBe(true);
    expect(outboxEffectInstalled("git_commit")).toBe(true);
    expect(outboxEffectInstalled(`missing_${randomUUID()}`)).toBe(false);
  });

  it("the website module installs its effects", () => {
    registerShippedModules();
    expect(outboxEffectInstalled("site_rebuild")).toBe(true);
    expect(outboxEffectInstalled("pages_push")).toBe(true);
    expect(outboxEffectInstalled("site_bundle")).toBe(true);
  });

  it("mountModules registers a module's outbox effects", () => {
    const kind = `module_${randomUUID()}`;
    const probe: ModuleDefinition = { id: `probe-${kind}`, registerRoutes: () => {}, outboxEffects: [effect(kind)] };
    mountModules(new Hono() as unknown as ModuleApp, [probe]);
    expect(outboxEffectInstalled(kind)).toBe(true);
  });
});

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("outbox effect registry (database)", () => {
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Outbox effects',$1) RETURNING id", [randomUUID()])).rows[0].id;
    admin = await persistActor(ws, admin);
  });
  afterAll(async () => { await db.q("DELETE FROM outbox WHERE workspace_id=$1", [ws]); });

  it("keeps an intent of an unregistered kind pending until its effect is registered", async () => {
    const kind = `late_${randomUUID()}`;
    const id = await enqueueEffect({ workspaceId: ws, kind, dedupKey: `${kind}:1`, payload: { value: "kept" } });

    await drainOutbox({ id });
    // Not dead and no attempt consumed: deleting a module must not lose work.
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 0, deferred: true });
    expect((await row(id)).last_error).toMatch(/no registered outbox effect/);

    const performed: unknown[] = [];
    registerOutboxEffect(effect(kind, performed));
    await db.q("UPDATE outbox SET next_attempt_at = now() WHERE id = $1::bigint", [id]);
    await drainOutbox({ id });
    expect(performed).toEqual(["kept"]);
    expect((await row(id)).status).toBe("done");
  });

  it("folds repeated enqueues into one pending intent carrying the newest payload", async () => {
    const kind = `fold_${randomUUID()}`;
    const first = await enqueueEffect({ workspaceId: ws, kind, dedupKey: `${kind}:x`, payload: { value: "old" } });
    const second = await enqueueEffect({ workspaceId: ws, kind, dedupKey: `${kind}:x`, payload: { value: "new" } });
    expect(second).toBe(first);
    const stored = await db.q<{ payload: { value: string } }>("SELECT payload FROM outbox WHERE id = $1::bigint", [first]);
    expect(stored.rows[0].payload.value).toBe("new");
  });

  it("refuses to approve a held intent no installed module can perform", async () => {
    const kind = `held_${randomUUID()}`;
    const id = await enqueueEffect({ workspaceId: ws, kind, dedupKey: `${kind}:1`, payload: { value: "x" }, held: true });
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    app.onError(apiOnError);
    app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
    app.route("/api/inbox", inboxRouter);

    const res = await app.request(`/api/inbox/approvals/${id}/approve`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "effect_unavailable" });
    expect((await row(id)).status).toBe("pending_approval");
  });
});
