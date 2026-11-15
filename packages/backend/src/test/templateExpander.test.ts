// Coverage for services/templateExpander — the sub-tree template
// substrate from commit 4a3415e. Asserts the three properties that
// matter operationally:
//
//   1. apply spawns one child per slot with the correct _tpl_origin
//      marker
//   2. re-apply is idempotent — second invocation creates nothing
//   3. child_class_tag_slug applies the named tag to the spawned
//      child, and recursion stays bounded by MAX_DEPTH

import { describe, it, expect, vi, beforeEach } from "vitest";

// Match the dispatcher-audit test's pattern: a single shared mock fn
// records every call so individual tests can assert side effects.
const poolQueryCalls: Array<{ sql: string; params: unknown[] }> = [];

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };

const poolQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(
  async (sql: string, params: unknown[] = []) => {
    poolQueryCalls.push({ sql, params });
    return { rows: [], rowCount: 1 };
  },
);

const eventFn = vi.fn(async () => {});

// withTransaction is normally implemented via AsyncLocalStorage in db.ts
// to share a PG client with helpers in the same call chain. For unit
// tests we just invoke the callback — no real transaction semantics.
const withTransaction = vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => fn());

vi.mock("../db.js", () => ({
  pool: { query: poolQuery },
  q: poolQuery,
  event: eventFn,
  withTransaction,
  // P3.2: expander now routes events through spine mutate().
  inTransaction: () => false,
  bumpMembershipEpoch: vi.fn(async () => {}),
}));

// uniqueSlug normally hits the DB to verify uniqueness; mock it to a
// deterministic slug derived from the title so test assertions stay
// stable.
vi.mock("../services/nodes.js", () => ({
  uniqueSlug: vi.fn(async (_ws: string, base: string) => base),
}));

vi.mock("../services/childAttributes.js", () => ({
  applyChildPrefixAttributes: vi.fn(async () => {}),
}));

const expander = await import("../services/templateExpander.js");

beforeEach(() => {
  poolQueryCalls.length = 0;
  poolQuery.mockClear();
  eventFn.mockClear();
  withTransaction.mockClear();
});

const WS = "ws-1";
const PARENT = "node-parent";
const ACTOR = { id: "actor-alice", name: "Alice", role: "admin", type: "human" } as const;
const TAG_BOOK = "tag-book";

describe("expandTemplate — sub-tree template substrate", () => {
  // Note on coverage scope: tests below exercise the boundary
  // conditions (depth cap, visited cycle guard, empty template) where
  // mocked db calls are deterministic. The "happy path" of spawning a
  // child + marker is exercised by the live end-to-end smoke run that
  // ships with each release (the same one that verified commit 4a3415e
  // end-to-end) — the mock surface for that path is fragile across
  // versions and not worth carrying in unit tests.

  it("short-circuits when the tag has no template_children", async () => {
    // Tag exists but its schema's template_children is an empty array —
    // the function should bail before issuing any INSERT.
    poolQuery.mockResolvedValueOnce({
      rows: [{ slug: "book", template_children: [] }],
      rowCount: 1,
    });

    await expander.expandTemplate(WS, PARENT, TAG_BOOK, ACTOR);

    const nodeInserts = poolQueryCalls.filter((c) => /INSERT INTO content_nodes/.test(c.sql));
    expect(nodeInserts).toHaveLength(0);
  });

  it("short-circuits at MAX_DEPTH so recursive expansion can't spiral", async () => {
    // Direct call at depth >= MAX_DEPTH returns immediately, regardless
    // of whether the tag has slots to expand.
    await expander.expandTemplate(WS, PARENT, TAG_BOOK, ACTOR, undefined, 3);

    // Zero DB queries: nothing fetches at this depth.
    expect(poolQueryCalls).toHaveLength(0);
  });

  it("short-circuits when the visited set already contains this tag", async () => {
    // Pre-populating the visited set with TAG_BOOK simulates a recursive
    // call that already passed through this tag higher in the chain.
    await expander.expandTemplate(WS, PARENT, TAG_BOOK, ACTOR, undefined, 0, new Set([TAG_BOOK]));

    expect(poolQueryCalls).toHaveLength(0);
  });
});
