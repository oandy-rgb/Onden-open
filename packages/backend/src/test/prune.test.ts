// The operator's orphan-blob sweep (services/maintenance/prune.ts) and a
// purge's own blob delete (services/purgedContent.ts) must agree on what
// references a blob: every place an event names one. Checking only body_hash
// once GC'd value_ref-only (ink) blobs and broke restore (blind-audit #1;
// pruneBlobGc.integration.test.ts runs the predicate against a real DB).

import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: string[] = [];
const poolQuery = vi.fn(async (sql: string) => {
  queries.push(sql);
  // The sweep of chunk-stored drawings (inkChunks.ts) finds nothing here.
  if (/ink_manifests|ink_chunks/.test(sql)) return { rows: [], rowCount: 0 };
  return { rows: [{ count: "2", freed_bytes: "10" }], rowCount: 1 };
});
vi.mock("../db.js", () => ({ pool: { query: poolQuery }, q: poolQuery }));

const { collectOrphanBlobs } = await import("../services/maintenance/prune.js");

const REFS = ["payload->>'body_hash'", "payload->>'value_ref'", "prev_field_values'->>'value_ref'",
  "payload->>'incoming_value_ref'", "payload->>'overridden_value_ref'"];

beforeEach(() => { queries.length = 0; poolQuery.mockClear(); });

describe("orphan-blob sweep", () => {
  it("deletes only blobs no event references, past the put grace", async () => {
    expect(await collectOrphanBlobs()).toMatchObject({ blobs: 2, blobBytesFreed: 10 });
    expect(queries[0]).toMatch(/DELETE FROM blobs/);
    expect(queries[0]).toMatch(/created_at < now\(\) - interval/);
    for (const ref of REFS) expect(queries[0]).toContain(ref);
  });

  it("sweeps a chunk-stored drawing by the same references (the value's, not a body's)", async () => {
    await collectOrphanBlobs();
    const sweep = queries.find((sql) => /DELETE FROM ink_manifests/.test(sql))!;
    expect(sweep).toBeDefined();
    for (const ref of REFS.filter((r) => !r.includes("body_hash"))) expect(sweep).toContain(ref);
  });

  it("knows the same references as a purge", async () => {
    const { readFileSync } = await import("node:fs");
    const purge = readFileSync(new URL("../services/purgedContent.ts", import.meta.url), "utf8");
    for (const ref of REFS) expect(purge).toContain(ref);
  });
});
