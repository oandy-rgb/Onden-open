// D33 guard: the per-row `restorable` the event lists send and what restore
// actually does can never disagree.
//
//   - For every event-type literal in the backend source (a superset of what
//     can be emitted: anything that is not an event type simply classifies as
//     unsupported, so over-inclusion is harmless), an event row is restored
//     and previewed against a real database. A blocked row is refused with
//     exactly restoreBlockedError's code, before any state change; a
//     restorable row reaches an inverse (never "restore not implemented").
//   - GET /api/events carries `restorable` + `restore_blocked_reason`.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import eventsRouter from "../routes/events.js";
import { restoreEvent, previewEventRestore } from "../services/eventRestore/index.js";
import {
  BUILT_IN_RESTORED_EVENT_TYPES, DOMAIN_RESTORED_EVENT_TYPES, restoreBlockedError, restoreBlockedReason,
} from "../services/restoreContract.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every UPPER_SNAKE string literal in the backend source outside tests. */
function sourceEventTypeLiterals(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "test") walk(path);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        for (const m of readFileSync(path, "utf8").matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g)) found.add(m[1]!);
      }
    }
  };
  walk(SRC);
  return [...found].sort();
}

let admin: ActorCtx = { id: "d33-admin", name: "D33 admin", role: "admin", type: "human" };
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/events", eventsRouter);

describe.skipIf(!isTestDb)("restorable classification matches restore (D33) (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let seq = 0;

  async function freshNode(): Promise<string> {
    seq += 1;
    return (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'body') RETURNING id`,
      [WS, `d33 ${stamp} ${seq}`, `d33-${stamp}-${seq}`])).rows[0]!.id;
  }

  async function record(type: string, opts: { external?: boolean; txMeta?: Record<string, unknown> } = {}) {
    const nodeId = await freshNode();
    const id = await event(WS, type, "node", nodeId, {}, "user", admin.id, {
      txMeta: opts.txMeta ?? {}, external: opts.external ?? false,
    });
    return { id, row: { event_type: type, external: opts.external ?? false, tx_meta: opts.txMeta ?? {} } };
  }

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    currentActor = admin;
  });

  it("the source scan sees every type restore inverts (the scan is not vacuous)", () => {
    const literals = new Set(sourceEventTypeLiterals());
    for (const type of [...BUILT_IN_RESTORED_EVENT_TYPES, ...DOMAIN_RESTORED_EVENT_TYPES, "NODE_PURGED", "EDGE_CREATED"]) {
      expect(literals.has(type), type).toBe(true);
    }
  });

  it("blocked rows are refused with the classified reason; restorable rows reach an inverse", async () => {
    const cases: Array<{ type: string; external?: boolean; txMeta?: Record<string, unknown> }> = [
      ...sourceEventTypeLiterals().map((type) => ({ type })),
      { type: "NODE_UPDATED", external: true },
      { type: "NODE_RESTORED", txMeta: { inverse_patch: "", prev_field_values: {} } },
    ];
    const disagreements: string[] = [];
    const previewGaps = new Set<string>();
    for (const c of cases) {
      const { id, row } = await record(c.type, c);
      const blocked = restoreBlockedError(row);
      const label = `${c.type}${c.external ? " (external)" : ""}${c.txMeta ? " (with inverse)" : ""}`;
      let restored: { code?: string; status?: number; detail?: string; restored?: true };
      try {
        restored = await restoreEvent(id, { actor: admin, workspaceId: WS });
      } catch (error) {
        // A state-dependent failure inside an inverse (this fixture's empty
        // payload) still proves the type was dispatched to one.
        restored = { code: "threw", detail: String(error) };
      }
      const preview = await previewEventRestore(id, { actor: admin, workspaceId: WS }).catch((error: unknown) => ({ code: "threw", detail: String(error) }));
      if (blocked) {
        if (restored.code !== blocked.code || restored.status !== blocked.status) {
          disagreements.push(`${label}: classified ${blocked.code}, restore answered ${restored.code ?? "restored"}`);
        }
        if (!("code" in preview) || preview.code !== blocked.code) {
          disagreements.push(`${label}: classified ${blocked.code}, preview answered ${"code" in preview ? preview.code : "a preview"}`);
        }
      } else {
        if (restored.code === "unsupported" && /not implemented/.test(restored.detail ?? "")) {
          disagreements.push(`${label}: classified restorable, but restore has no inverse`);
        }
        if ("code" in preview && preview.code === "unsupported" && /not implemented/.test(preview.detail ?? "")) {
          previewGaps.add(c.type);
        }
      }
    }
    expect(disagreements).toEqual([]);
    // Known gap: a space move restores but has no preview shape yet, so the
    // preview dialog cannot confirm it. Shrink this list, never grow it.
    expect([...previewGaps]).toEqual(["NODE_MOVED_SPACE"]);
  }, 120_000);

  it("GET /api/events sends restorable and the blocked reason per row", async () => {
    const ok = await record("NODE_UPDATED", { txMeta: { inverse_patch: "", prev_field_values: {} } });
    const ext = await record("NODE_UPDATED", { external: true });
    const edge = await record("EDGE_CREATED");
    const res = await app.request(`/api/events?since=${BigInt(ok.id) - 1n}&limit=10`);
    expect(res.status).toBe(200);
    const events = ((await res.json()) as { events: Array<{ id: string; restorable: boolean; restore_blocked_reason: string | null }> }).events;
    const byId = new Map(events.map((e) => [String(e.id), e]));
    expect(byId.get(ok.id)).toMatchObject({ restorable: true, restore_blocked_reason: null });
    expect(byId.get(ext.id)).toMatchObject({ restorable: false, restore_blocked_reason: "external" });
    expect(byId.get(edge.id)).toMatchObject({ restorable: false, restore_blocked_reason: "unsupported" });
    for (const e of events) expect(e.restorable, String(e.id)).toBe(restoreBlockedReason(e as never) === null);
  });
});
