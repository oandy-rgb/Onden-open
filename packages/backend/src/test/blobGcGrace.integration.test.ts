// The orphan-blob GC can't take a blob a write is about to reference.
// putBlob runs before the referencing event commits; the GC only takes
// orphans older than BLOB_GC_GRACE, and putting an existing orphan again
// refreshes it (services/blobs.ts).
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { putBlob } from "../services/blobs.js";
import { collectOrphanBlobs } from "../services/maintenance/prune.js";
import { pruneEvents } from "../db.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const exists = async (hash: string) => (await q(`SELECT 1 FROM blobs WHERE hash = $1`, [hash])).rows.length === 1;
const age = (hash: string, interval: string) => q(`UPDATE blobs SET created_at = now() - $2::interval WHERE hash = $1`, [hash, interval]);
describe.skipIf(!isTestDb)("blob GC grace (DB)", () => {
  it("keeps a fresh orphan (a write that hasn't committed yet) and takes an old one", async () => {
    const fresh = await putBlob(`fresh ${randomUUID()}`);
    const old = await putBlob(`old ${randomUUID()}`);
    await age(old, "2 days");
    await collectOrphanBlobs();
    expect(await exists(fresh)).toBe(true);
    expect(await exists(old)).toBe(false);
  });

  it("putting an old orphan again (a new write with the same body) refreshes it, so the GC spares it", async () => {
    const body = `reused ${randomUUID()}`;
    const hash = await putBlob(body);
    await age(hash, "2 days");
    expect(await putBlob(body)).toBe(hash); // the racing write puts the same content
    await collectOrphanBlobs();
    expect(await exists(hash)).toBe(true);
  });

  it("event pruning keeps what a restore needs: NODE_DELETED roots and blob-backed values", async () => {
    const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Prune events', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    const target = randomUUID();
    const add = async (type: string, payload: object, txMeta: object = {}) => (await q<{ id: string }>(
      `INSERT INTO domain_events (id, workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta, created_at)
       VALUES (nextval(pg_get_serial_sequence('domain_events','id')), $1, 'user', 'u', $2, 'node', $3, $4, $5, now() - interval '30 days')
       RETURNING id::text`, [ws, type, target, JSON.stringify(payload), JSON.stringify(txMeta)])).rows[0]!.id;
    const deleted = await add("NODE_DELETED", {});
    const inkSet = await add("ATTRIBUTE_SET", { key: "ink_data", value_ref: "abc" });
    const inkUndo = await add("ATTRIBUTE_SET", { key: "ink_data" }, { prev_field_values: { value_ref: "def" } });
    const plain = await add("NODE_MOVED", { parent_id: null });
    await pruneEvents({ graceDays: 7 });
    const left = new Set((await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE workspace_id = $1`, [ws])).rows.map((r) => r.id));
    expect([...left].sort()).toEqual([deleted, inkSet, inkUndo].sort());
    expect(left.has(plain)).toBe(false);
  });

  it.skipIf(needsSecondConnection)("putting a blob inside a long transaction doesn't block or deadlock another write of the same content", async () => {
    const a = `shared-a ${randomUUID()}`;
    const b = `shared-b ${randomUUID()}`;
    await putBlob(a); await putBlob(b);
    await age(await putBlob(a), "2 hours"); await age(await putBlob(b), "2 hours"); // the refresh path takes the row lock
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Transaction 1 puts a then b and stays open; transaction 2 puts b then a.
    const t1 = withTransaction(async () => { await putBlob(a); await putBlob(b); await gate; });
    const t2 = withTransaction(async () => { await putBlob(b); await putBlob(a); });
    const winner = await Promise.race([t2.then(() => "t2 done"), new Promise((r) => setTimeout(() => r("t2 blocked"), 3000))]);
    release();
    await t1; await t2;
    expect(winner).toBe("t2 done");
  });
});
