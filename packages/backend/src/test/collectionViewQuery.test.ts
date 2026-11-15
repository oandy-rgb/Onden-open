// M3.2: collection_views query exec unit tests.
//
// Pool.query is mocked so we assert the SQL shape (WHERE clauses + param
// order) without booting PG. Real semantic verification happens in the
// integration smoke (M3.2 follow-up commit) which runs against the dev DB.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type QueryResult<T extends Row = Row> = { rows: T[]; rowCount: number };
const queries: Array<{ sql: string; params: unknown[] }> = [];
let resultQueue: QueryResult[] = [];

const poolQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
  queries.push({ sql, params });
  return resultQueue.shift() ?? { rows: [], rowCount: 0 };
});

vi.mock("../db.js", () => ({
  pool: { query: poolQuery },
  q: poolQuery,
}));

const { executeView } = await import("../services/collectionViewQuery.js");

beforeEach(() => {
  queries.length = 0;
  resultQueue = [];
  poolQuery.mockClear();
});

// L1: executeView issues a `descendantsOf` SQL before the main SELECT.
// All tests need an empty descendants result primed first so the main
// query runs against the original tag id only. mainQuery() returns
// the SELECT n.id ... query (filters out the CTE).
function primeDescendants(ids: string[] = []) {
  resultQueue.push({ rows: ids.map((id) => ({ id })), rowCount: ids.length });
}
function mainQuery() {
  return queries.find((q) => q.sql.includes("SELECT n.id, n.title")) ?? queries[queries.length - 1];
}

describe("M3.2 executeView — base query", () => {
  it("scopes to workspace + tag, excludes soft-deleted + hidden", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [], visibleFields: [],
    });
    const sql = mainQuery().sql;
    expect(sql).toMatch(/n\.workspace_id = \$1/);
    expect(sql).toMatch(/n\.deleted_at IS NULL/);
    expect(sql).toMatch(/n\.hidden = false/);
    expect(sql).toMatch(/EXISTS .*node_tags nt.*nt\.tag_id = ANY/s);
    // read-policy iron law: the caller's read set bounds every row
    expect(sql).toMatch(/n\.id = ANY\(\$3::uuid\[\]\)/);
  });

  it("default order is sort_order ASC then title ASC", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/ORDER BY n\.sort_order ASC, n\.title ASC/);
  });
});

describe("executeView — the order is total", () => {
  it("ends every ORDER BY with the id, whatever the sort keys are", async () => {
    for (const sorts of [[], [{ field: "title", dir: "desc" as const }], [{ field: "status", dir: "asc" as const }]]) {
      queries.length = 0;
      primeDescendants();
      resultQueue.push({ rows: [], rowCount: 0 });
      await executeView({ workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"], filters: [], sorts, visibleFields: [] });
      expect(mainQuery().sql).toMatch(/ORDER BY[\s\S]*, n\.id ASC\s+LIMIT/);
    }
  });
});

describe("M3.2 filter ops — built-in fields", () => {
  it("eq → exact match on built-in", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "title", op: "eq", value: "hello" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/n\.title = \$4/);
    expect(mainQuery().params).toContain("hello");
  });

  it("contains → ILIKE %?% on built-in", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "title", op: "contains", value: "foo" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/n\.title::text ILIKE \$4/);
    expect(mainQuery().params).toContain("%foo%");
  });

  it("empty → IS NULL OR '' on built-in", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "title", op: "empty" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/n\.title IS NULL OR n\.title::text = ''/);
  });
});

describe("M3.2 filter ops — attribute fields", () => {
  it("eq → EXISTS subquery against node_attributes", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "priority", op: "eq", value: "high" }],
      sorts: [], visibleFields: [],
    });
    const sql = mainQuery().sql;
    expect(sql).toMatch(/EXISTS .*node_attributes na/s);
    expect(sql).toMatch(/na\.key = \$4[\s\S]*na\.value = \$5/);
    // L1: tag-id slot now holds the {tagId + descendants} array.
    expect(mainQuery().params).toEqual(["ws-1", ["tag-1"], ["allow-1"], "priority", "high", 201, 0]);
  });

  it("ne → NOT EXISTS subquery (missing attribute counts as ne)", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "status", op: "ne", value: "doing" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/NOT EXISTS .*node_attributes na/s);
  });

  it("nempty → EXISTS with na.value <> ''", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "due", op: "nempty" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/EXISTS .*na\.value <> ''/s);
  });

  it("gte with a numeric value → number arm ONLY (single typed cast, no OR)", async () => {
    // Range ops cast by the COMPARISON VALUE's format, chosen at build time, and
    // emit exactly ONE arm. The number+date OR form is unsafe: Postgres
    // constant-folds the value cast in BOTH arms, so "5"::timestamptz 500s every
    // range query (see services/filter/sqlClauses.ts). A "5" value → number arm;
    // the row-side regex guard still excludes mistyped stored values.
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "rating", op: "gte", value: "5" }],
      sorts: [], visibleFields: [],
    });
    const sql = mainQuery().sql;
    expect(sql).toMatch(/EXISTS .*node_attributes na/s);
    // The bound param is cast text→numeric (($5::text)::numeric) so a value
    // arriving as any pg type normalises before the numeric compare.
    expect(sql).toMatch(/value_type = 'number'[\s\S]*?na\.value::numeric END\) >= \(\$5::text\)::numeric/);
    expect(sql).not.toMatch(/value_type = 'date'/); // no OR'd date arm
    expect(mainQuery().params).toEqual(["ws-1", ["tag-1"], ["allow-1"], "rating", "5", 201, 0]);
  });

  it("gte with a date value → date arm ONLY (single typed cast)", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "due", op: "gte", value: "2020-01-01" }],
      sorts: [], visibleFields: [],
    });
    const sql = mainQuery().sql;
    expect(sql).toMatch(/value_type = 'date'[\s\S]*?THEN na\.value::timestamptz END\) >= \(\$5::text\)::timestamptz/);
    expect(sql).not.toMatch(/value_type = 'number'/); // no OR'd number arm
  });

  it("lt on attribute → < comparator", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "rating", op: "lt", value: "3" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/na\.value::numeric END\) < \(\$5::text\)::numeric/);
  });
});

describe("M3.2 range ops — built-in fields", () => {
  it("gt on date column casts the param to timestamptz", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "created_at", op: "gt", value: "2026-01-01" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/n\.created_at > \$4::timestamptz/);
    expect(mainQuery().params).toContain("2026-01-01");
  });

  it("lte on sort_order casts the param to numeric", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "sort_order", op: "lte", value: "10" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/n\.sort_order <= \$4::numeric/);
  });

  it("gte on text column (title) compares lexicographically, no cast", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [{ field: "title", op: "gte", value: "m" }],
      sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/n\.title >= \$4(?!::)/);
  });
});

describe("M3.2 sorts", () => {
  it("built-in sort field → n.<field> DIR NULLS LAST", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [],
      sorts: [{ field: "updated_at", dir: "desc" }],
      visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/ORDER BY n\.updated_at DESC NULLS LAST/);
  });

  it("attribute sort field → correlated subquery", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [],
      sorts: [{ field: "rating", dir: "asc" }],
      visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/SELECT value FROM node_attributes na[\s\S]*?\.key = \$4[\s\S]*?ASC NULLS LAST/);
  });

  it("attribute sort casts number/date fields by value_type, not as text", async () => {
    // Regression: number/date attrs sorted lexicographically ("10" < "9").
    // The ORDER BY must layer a value_type-gated numeric cast and a
    // timestamptz cast ahead of the raw-text key, each regex-guarded so
    // bad data sorts NULL rather than 500-ing the query.
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [],
      sorts: [{ field: "rating", dir: "asc" }],
      visibleFields: [],
    });
    const sql = mainQuery().sql;
    // numeric cast keyed off value_type, regex-guarded
    expect(sql).toMatch(/value_type = 'number'[\s\S]*?na\.value::numeric/);
    // date cast keyed off value_type, regex-guarded
    // Dates sort as ISO text (no cast that a stray 2024-02-30 could fail).
    expect(sql).toMatch(/value_type = 'date'[\s\S]*?THEN na\.value END/);
    // typed keys come BEFORE the raw-text fallback key
    const numericPos = sql.indexOf("::numeric");
    const datePos = sql.indexOf("value_type = 'date'");
    const rawTextPos = sql.indexOf("SELECT value FROM node_attributes");
    expect(numericPos).toBeGreaterThan(-1);
    expect(datePos).toBeGreaterThan(numericPos);
    expect(rawTextPos).toBeGreaterThan(datePos);
  });
});

describe("M3.2 visible_fields hydration", () => {
  it("returns built-in field values from the base query", async () => {
    // Base SELECT result with 1 row.
    primeDescendants();
    resultQueue.push({
      rows: [{ id: "n-1", title: "T", slug: "s", updated_at: "2026-06-01T00:00:00Z" }],
      rowCount: 1,
    });
    // Attribute hydration: skipped because no attr fields requested.
    const result = await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [],
      visibleFields: ["title", "updated_at"],
    });
    expect(result.rows[0].attributes).toEqual({
      title: "T", updated_at: "2026-06-01T00:00:00Z",
    });
    expect(queries).toHaveLength(2); // descendants + base, no attr query
  });

  it("hydrates attribute fields via single batch SELECT", async () => {
    primeDescendants();
    resultQueue.push({
      rows: [
        { id: "n-1", title: "A", slug: "a", updated_at: "x" },
        { id: "n-2", title: "B", slug: "b", updated_at: "y" },
      ],
      rowCount: 2,
    });
    resultQueue.push({
      rows: [
        { node_id: "n-1", key: "status", value: "doing" },
        { node_id: "n-2", key: "status", value: "done" },
        { node_id: "n-1", key: "priority", value: "high" },
      ],
      rowCount: 3,
    });
    const result = await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [],
      visibleFields: ["title", "status", "priority"],
    });
    expect(result.rows[0].attributes).toMatchObject({
      title: "A", status: "doing", priority: "high",
    });
    expect(result.rows[1].attributes).toMatchObject({
      title: "B", status: "done", priority: null,
    });
    // 1 SELECT for the base query + 1 SELECT for the attr batch.
    expect(queries).toHaveLength(3); // descendants + base + attr batch
    expect(queries[2].sql).toMatch(/node_id = ANY/);
    expect(queries[2].sql).toMatch(/key = ANY/);
  });

  it("missing attributes render as null, not absent", async () => {
    primeDescendants();
    resultQueue.push({
      rows: [{ id: "n-1", title: "T", slug: "s", updated_at: "x" }],
      rowCount: 1,
    });
    resultQueue.push({ rows: [], rowCount: 0 });
    const result = await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [],
      visibleFields: ["nonexistent"],
    });
    expect(result.rows[0].attributes).toEqual({ nonexistent: null });
  });
});

describe("M3.2 limit", () => {
  // The SQL fetches limit+1 (a probe row) to detect a next page; the page size
  // is still 200/500 after the probe row is dropped (M1). LIMIT and OFFSET are
  // bound parameters, never written into the SQL text (D66).
  const tail = () => mainQuery().params.slice(-2);
  it("default limit is 200 (fetches 201 to probe for more), bound as parameters", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [], visibleFields: [],
    });
    expect(mainQuery().sql).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(tail()).toEqual([201, 0]);
  });

  it("caller limit is hard-capped at 500 (fetches 501 to probe)", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [], visibleFields: [],
      limit: 9999,
    });
    expect(tail()).toEqual([501, 0]);
  });

  it("a negative or fractional limit/offset from an internal caller is clamped, never reaching SQL", async () => {
    primeDescendants();
    resultQueue.push({ rows: [], rowCount: 0 });
    await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [], visibleFields: [], limit: -5, offset: -2.5,
    });
    expect(tail()).toEqual([2, 0]);
  });

  it("answers a Page: next offset when the probe row comes back, the probe dropped, total from the window count", async () => {
    primeDescendants();
    // 3 base rows for a limit of 2 → one is the probe.
    resultQueue.push({ rows: [{ id: "a", total: "7" }, { id: "b", total: "7" }, { id: "c", total: "7" }], rowCount: 3 });
    const r = await executeView({
      workspaceId: "ws-1", tagId: "tag-1", readableIds: ["allow-1"],
      filters: [], sorts: [], visibleFields: [], limit: 2, offset: 4,
    });
    expect(r.next).toBe(6);
    expect(r.rows.map((x) => x.id)).toEqual(["a", "b"]); // probe row dropped
    expect(r.count).toBe(2);
    expect(r.total).toBe(7);
  });
});
