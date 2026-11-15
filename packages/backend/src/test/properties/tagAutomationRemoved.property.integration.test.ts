// Tag automation is gone (owner decision 2026-11-15: functions replaced it). Rules an old tag still carries
// under behaviour.on_apply / on_remove / on_attribute_change stay in tag_schema, inert.
//
// Invariant: random stored rules on tags + a random sequence of applies, removals, attribute writes and
// body saves leave NO extra event and NO extra attribute compared with the same sequence on tags without
// rules (tag field defaults still seed in both). Rules include malformed ones and every old handler kind.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/tagAutomationRemoved.property.integration.test.ts
// SAFETY: only runs against a *_test database; skips otherwise.

import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { q, pool } from "../../db.js";
import nodesRouter from "../../routes/nodes.js";
import { persistActor } from "../helpers/persistActor.js";
import { seedClassTag } from "../helpers/seedClassTag.js";
import { checkAsync } from "../helpers/propsConfig.js";
import type { ActorCtx } from "../../types.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));
let owner: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
app.route("/api/nodes", nodesRouter);

const send = (url: string, method: string, body?: unknown) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

// ── Random stored rules (written raw: the routes would drop them) ───────────
const key = fc.constantFrom("status", "stage", "x", "owner");
const leaf: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.record({ type: fc.constant("set_attribute"), key, value: fc.constantFrom("todo", "done", "$today", "$attr.status") }),
  fc.record({ type: fc.constant("delete_attribute"), key }),
  fc.record({ type: fc.constant("notify"), message: fc.constantFrom("hi", "changed $attr.status") }),
  fc.record({ type: fc.constant("set_hidden"), value: fc.boolean() }),
  fc.constant({ type: "builtin", name: "x" }),
  fc.constant({ type: "explode" }),               // an unknown kind
  fc.constant({ type: "sequence" }),              // malformed: no steps
);
const rule: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  leaf,
  fc.record({ type: fc.constant("when"), if_key: key, equals: fc.constantFrom("todo", "done"), then: leaf }),
  fc.record({ type: fc.constant("sequence"), steps: fc.array(leaf, { maxLength: 3 }) }),
);
const behaviour = fc.record({ on_apply: rule, on_remove: rule, on_attribute_change: rule }, { requiredKeys: [] });

// ── Random writes, by tag / note index ──────────────────────────────────────
type Op =
  | { kind: "apply" | "remove"; note: number; tag: number }
  | { kind: "set"; note: number; key: string; value: string }
  | { kind: "delete"; note: number; key: string }
  | { kind: "body"; note: number; value: string };
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constantFrom("apply" as const, "remove" as const), note: fc.nat(1), tag: fc.nat(1) }),
  fc.record({ kind: fc.constant("set" as const), note: fc.nat(1), key, value: fc.constantFrom("todo", "done", "x") }),
  fc.record({ kind: fc.constant("delete" as const), note: fc.nat(1), key }),
  fc.record({ kind: fc.constant("body" as const), note: fc.nat(1), value: fc.constantFrom("todo", "done") }),
);

const FIELDS = [{ name: "stage", type: "text", default: "todo" }, { name: "status", type: "text" }];

async function world(label: string, rules: Array<Record<string, unknown>> | null) {
  const tags: string[] = [];
  for (let i = 0; i < 2; i++) {
    tags.push((await seedClassTag(WS, {
      name: `${label}-${i}-${randomUUID().slice(0, 8)}`, nodeSlug: `${label}-${i}-${randomUUID()}`,
      fields: FIELDS, ...(rules ? { behaviour: rules[i]! } : {}),
    })).tagId);
  }
  const notes: string[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await send("/api/nodes", "POST", { title: `${label} note ${i} ${randomUUID().slice(0, 6)}`, markdown: "start" });
    expect(res.status, await res.clone().text()).toBe(201);
    notes.push(((await res.json()) as { id: string }).id);
  }
  return { tags, notes };
}

async function run(w: { tags: string[]; notes: string[] }, ops: Op[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const o of ops) {
    const id = w.notes[o.note]!;
    let res: Response;
    if (o.kind === "apply") res = await send(`/api/nodes/${id}/tags/${w.tags[o.tag]}`, "PUT");
    else if (o.kind === "remove") res = await send(`/api/nodes/${id}/tags/${w.tags[o.tag]}`, "DELETE");
    else if (o.kind === "set") res = await send(`/api/nodes/${id}/attributes/${o.key}`, "PUT", { value: o.value });
    else if (o.kind === "delete") res = await send(`/api/nodes/${id}/attributes/${o.key}`, "DELETE");
    else res = await send(`/api/nodes/${id}`, "PATCH", { markdown: `status:: ${(o as Extract<Op, { kind: "body" }>).value}\n` });
    statuses.push(res.status);
    // What a body's `key:: value` lines give the note is written after the save answers (services/dispatcherQueue):
    // wait for it before the next write, so both worlds record their events in the same order.
    await awaitAllDispatchers();
  }
  return statuses;
}

/** What a note ended up with, with ids left out so the two worlds compare. */
async function outcome(noteId: string) {
  const events = (await q<{ event_type: string; ui_context: string | null }>(
    `SELECT event_type, tx_meta->>'ui_context' AS ui_context FROM domain_events WHERE target_id = $1 ORDER BY id`, [noteId])).rows;
  const attributes = (await q<{ key: string; value: string; source: string }>(
    `SELECT key, value, source FROM node_attributes WHERE node_id = $1 ORDER BY key`, [noteId])).rows;
  return { events: events.map((e) => `${e.event_type}|${e.ui_context ?? ""}`), attributes };
}

afterAll(async () => { if (isTestDb) await pool.end(); });

describe.skipIf(!isTestDb)("old tag automation never runs (property)", () => {
  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Automation gone', $1) RETURNING id::text`, [`auto-gone-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "ag-owner", name: "Owner", role: "admin", type: "human" });
  });

  it("stored rules add no event and no attribute to any write", async () => {
    await checkAsync(fc.asyncProperty(fc.tuple(behaviour, behaviour), fc.array(op, { minLength: 1, maxLength: 8 }), async (rules, ops) => {
      const withRules = await world("ruled", rules);
      const plain = await world("plain", null);
      const a = await run(withRules, ops);
      const b = await run(plain, ops);
      expect(a).toEqual(b);
      for (let i = 0; i < 2; i++) {
        const [ruled, base] = [await outcome(withRules.notes[i]!), await outcome(plain.notes[i]!)];
        expect(ruled).toEqual(base);
        // Nothing the old runner recorded.
        expect(ruled.events.filter((e) => /NOTIFICATION|CASCADE_|DISPATCHER_FAILED|dispatcher\./.test(e))).toEqual([]);
      }
    }), 20);
  }, 600_000);
});
