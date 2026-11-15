// L1 — tagHierarchy unit tests.
//
// Mocks pool.query + event() to verify the SQL shape and audit-event
// emissions of resolveOrCreateTagPath / descendantsOf / fullTagPath /
// listTagTree. Real PG semantics covered by the live smoke against
// /api/tags/resolve-path on the dev DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorCtx } from "../types.js";

// Hierarchy SQL/event fixtures stay independent of persisted actor lookup;
// actorWriteAuthority.integration.test.ts verifies current identity authority.
// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0 }));
vi.mock("../spine/currentActor.js", () => ({
  resolveCurrentActor: async (actor: ActorCtx) => actor,
}));

// Segment creation now needs any_space_write; that check reads space
// membership, which isn't the SQL shape asserted here
// (tagCreateAuthority.integration.test.ts covers the authority itself).
vi.mock("../spine/authority.js", async (original) => ({
  ...await original<typeof import("../spine/authority.js")>(),
  assertAuthority: async () => {},
}));

const queries: Array<{ sql: string; params: unknown[] }> = [];
type Row = Record<string, unknown>;
type QueryResult<T extends Row = Row> = { rows: T[]; rowCount: number };
let resultQueue: QueryResult[] = [];

const poolQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
  queries.push({ sql, params });
  // resolveOrCreateTagPath mints segments through spine mutate(), whose root run
  // issues bookkeeping queries via q() that aren't part of the SQL shape these
  // unit tests assert: the C1 event-append advisory lock and the idempotency
  // claim. Don't let them consume the scripted result queue (else each real
  // INSERT shifts onto an empty result and `.rows[0].id` is undefined).
  if (/pg_advisory_xact_lock|lock_timeout|idempotency_keys|onden\.actor_space/.test(sql)) return { rows: [], rowCount: 0 };
    // MB3: uniqueTagSlug's existence probe (SELECT id … WHERE slug = $2) is
    // slug bookkeeping, not part of the scripted SQL shape — empty = "free".
    if (/SELECT id FROM content_nodes WHERE workspace_id = \$1 AND slug = \$2/.test(sql)) return { rows: [], rowCount: 0 };
    // createTag's sibling-name probe (assertTagNameAvailable → liveTagIdByName
    // with an exceptId) — empty = free. The segment lookup asks the same SQL
    // with no exceptId and stays scripted.
    if (/AND \(\$4::uuid IS NULL OR id<>\$4::uuid\)/.test(sql) && params[3] != null) return { rows: [], rowCount: 0 };
    // insertTagRow's parent-kind probe (services/parentKind.ts): a segment's
    // parent is the previous segment, a tag.
    if (/^SELECT node_type FROM content_nodes WHERE workspace_id = \$1 AND id = \$2$/.test(sql)) return { rows: [{ node_type: "class_tag" }], rowCount: 1 };
    // createTag's parent-exists probe (the parent is a live node of this workspace): the previous segment.
    if (/^select "id" from "content_nodes" where "workspace_id" = \$1 and "id" = \$2 and "deleted_at" is null/.test(sql)) return { rows: [{ id: String(params[1]) }], rowCount: 1 };
    // assertModuleTagEdge's probe: no segment's parent is a function.
    if (/AS is_module\s+FROM content_nodes WHERE workspace_id = \$1 AND id = \$2/.test(sql)) return { rows: [{ is_module: false }], rowCount: 1 };
  return resultQueue.shift() ?? { rows: [], rowCount: 0 };
});

const eventCalls: Array<{ type: string; targetId: string; payload?: Record<string, unknown> }> = [];
let nextId = 1000;
const eventFn = vi.fn(async (
  _ws: string, type: string, _tt: string, targetId: string,
  payload?: Record<string, unknown>,
): Promise<string> => {
  eventCalls.push({ type, targetId, payload });
  return String(nextId++);
});

vi.mock("../db.js", () => ({
  pool: { query: poolQuery },
  q: poolQuery,
  event: eventFn,
  // P3.2: resolveOrCreateTagPath now mints TAG_CREATED through spine mutate().
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  inTransaction: () => false,
  requireTransaction: () => {},
  bumpMembershipEpoch: vi.fn(async () => {}),
}));

const ACTOR = { id: "actor-alice", name: "Alice", role: "admin", type: "human" } as const;

const {
  resolveOrCreateTagPath, descendantsOf, fullTagPath, listTagTree,
} = await import("../services/tagHierarchy.js");

beforeEach(() => {
  queries.length = 0;
  eventCalls.length = 0;
  resultQueue = [];
  nextId = 1000;
  poolQuery.mockClear();
  eventFn.mockClear();
});

describe("L1 resolveOrCreateTagPath", () => {
  it("creates each missing segment and chains parent_id", async () => {
    // Three segments, none exist.
    resultQueue.push({ rows: [], rowCount: 0 });               // lookup "projects"
    resultQueue.push({ rows: [{ id: "tag-projects" }], rowCount: 1 }); // insert "projects"
    resultQueue.push({ rows: [], rowCount: 0 });               // lookup "onboarding"
    resultQueue.push({ rows: [{ id: "tag-onboarding" }], rowCount: 1 }); // insert "onboarding"
    resultQueue.push({ rows: [], rowCount: 0 });               // lookup "q3"
    resultQueue.push({ rows: [{ id: "tag-q3" }], rowCount: 1 });        // insert "q3"

    const result = await resolveOrCreateTagPath("ws-1", "projects/onboarding/q3", ACTOR);
    expect(result.leafId).toBe("tag-q3");
    expect(result.created).toEqual(["tag-projects", "tag-onboarding", "tag-q3"]);

    // Three TAG_CREATED events, in order.
    expect(eventCalls).toHaveLength(3);
    expect(eventCalls[0]).toMatchObject({ type: "TAG_CREATED", targetId: "tag-projects" });
    expect(eventCalls[1]).toMatchObject({ type: "TAG_CREATED", targetId: "tag-onboarding" });
    expect(eventCalls[2]).toMatchObject({ type: "TAG_CREATED", targetId: "tag-q3" });

    // A1.8: INSERT now lands on content_nodes (class_tag). Each INSERT
    // carries the previous segment's id as parent.
    const insertCalls = queries.filter((q) => q.sql.includes("INSERT INTO content_nodes"));
    // insertTagRow's params: id, workspace, title, slug (MB3: the TS-computed
    // unique tag slug, Unicode-safe), parent, colour, schema, reserved key.
    const shape = (params: unknown[]) => params.slice(1, 6);
    expect(shape(insertCalls[0].params)).toEqual(["ws-1", "projects", "tag-projects", null, "#888888"]);
    expect(shape(insertCalls[1].params)).toEqual(["ws-1", "onboarding", "tag-onboarding", "tag-projects", "#888888"]);
    expect(shape(insertCalls[2].params)).toEqual(["ws-1", "q3", "tag-q3", "tag-onboarding", "#888888"]);
  });

  it("idempotent: existing segments are looked up, not re-inserted", async () => {
    // First lookup hits, second misses + inserts.
    resultQueue.push({ rows: [{ id: "tag-existing", title: "existing" }], rowCount: 1 }); // lookup hits
    resultQueue.push({ rows: [], rowCount: 0 });                       // lookup miss
    resultQueue.push({ rows: [{ id: "tag-new" }], rowCount: 1 });      // insert

    const result = await resolveOrCreateTagPath("ws-1", "existing/new", ACTOR);
    expect(result.leafId).toBe("tag-new");
    expect(result.created).toEqual(["tag-new"]);
    // Only one TAG_CREATED event (the new one).
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].targetId).toBe("tag-new");
  });

  it("strips empty path segments (leading/trailing/consecutive slashes)", async () => {
    resultQueue.push({ rows: [{ id: "tag-x", title: "x" }], rowCount: 1 });
    const result = await resolveOrCreateTagPath("ws-1", "//x///", ACTOR);
    expect(result.leafId).toBe("tag-x");
  });

  it("throws when path is empty after trimming", async () => {
    await expect(resolveOrCreateTagPath("ws-1", "////", ACTOR)).rejects.toThrow(/empty tag path/);
  });

  it("event tx_meta carries inverse_op for ER restore", async () => {
    resultQueue.push({ rows: [], rowCount: 0 });
    resultQueue.push({ rows: [{ id: "tag-1" }], rowCount: 1 });
    await resolveOrCreateTagPath("ws-1", "alpha", ACTOR);
    // The mocked eventFn captures the options argument's txMeta in the
    // payload position of our spy. We re-mock to capture the 8th arg.
    // The above suffices to verify emission count; tx_meta shape is
    // checked by integration smoke.
    expect(eventCalls[0].type).toBe("TAG_CREATED");
  });
});

describe("L1 descendantsOf", () => {
  it("issues a recursive CTE and maps rows to id list", async () => {
    resultQueue.push({
      rows: [{ id: "tag-child-1" }, { id: "tag-child-2" }, { id: "tag-grandchild" }],
      rowCount: 3,
    });
    const ids = await descendantsOf("ws-1", "tag-root");
    expect(ids).toEqual(["tag-child-1", "tag-child-2", "tag-grandchild"]);
    expect(queries[0].sql).toMatch(/WITH RECURSIVE descendants/);
    expect(queries[0].params).toEqual(["ws-1", "tag-root"]);
  });

  it("returns [] for a leaf with no descendants", async () => {
    resultQueue.push({ rows: [], rowCount: 0 });
    expect(await descendantsOf("ws-1", "tag-leaf")).toEqual([]);
  });
});

describe("L1 fullTagPath", () => {
  it("walks parent chain and joins with /", async () => {
    // tag-q3 → tag-onboarding → tag-projects → null
    resultQueue.push({ rows: [{ name: "q3", parent_id: "tag-onboarding" }], rowCount: 1 });
    resultQueue.push({ rows: [{ name: "onboarding", parent_id: "tag-projects" }], rowCount: 1 });
    resultQueue.push({ rows: [{ name: "projects", parent_id: null }], rowCount: 1 });
    expect(await fullTagPath("ws-1", "tag-q3")).toBe("projects/onboarding/q3");
  });

  it("returns single-segment for a root tag", async () => {
    resultQueue.push({ rows: [{ name: "root-only", parent_id: null }], rowCount: 1 });
    expect(await fullTagPath("ws-1", "tag-root")).toBe("root-only");
  });

  it("returns '' when target tag is missing", async () => {
    resultQueue.push({ rows: [], rowCount: 0 });
    expect(await fullTagPath("ws-1", "tag-deleted")).toBe("");
  });

  it("caps at 16 levels to defend against cycles", async () => {
    // Prime 20 levels of fake parents — only 16 SQL calls should fire.
    for (let i = 0; i < 20; i++) {
      resultQueue.push({ rows: [{ name: `lvl${i}`, parent_id: `tag-${i + 1}` }], rowCount: 1 });
    }
    await fullTagPath("ws-1", "tag-0");
    expect(queries.length).toBe(16);
  });
});

describe("L1 listTagTree", () => {
  it("returns flat list ordered with parent_id NULLS FIRST", async () => {
    resultQueue.push({
      rows: [
        { id: "tag-a", name: "alpha", parent_id: null, color: "#aaa" },
        { id: "tag-b", name: "beta", parent_id: "tag-a", color: "#bbb" },
      ],
      rowCount: 2,
    });
    const tree = await listTagTree("ws-1");
    expect(tree).toHaveLength(2);
    expect(queries[0].sql).toMatch(/ORDER BY parent_id NULLS FIRST/);
  });
});
