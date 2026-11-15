import { describe, it, expect } from "vitest";
import {
  BUILT_IN_FIELDS,
  EMPTY_GROUP_KEY,
  aggregateField,
  fieldValue,
  fieldValues,
  movedValue,
  formatFooter,
  groupKey,
  groupLabel,
  groupRows,
  type GroupableRow,
} from "../components/viewLayoutKit";

function row(id: string, attrs: Record<string, string | null>, over: Partial<GroupableRow> = {}): GroupableRow {
  return {
    id,
    title: over.title ?? `t-${id}`,
    slug: over.slug ?? `s-${id}`,
    updated_at: over.updated_at ?? "2026-01-01T00:00:00Z",
    attributes: attrs,
  };
}

const labels = (groups: { value: string | null }[]) => groups.map((g) => groupLabel(g));

describe("groupRows", () => {
  it("buckets rows by an attribute value, preserving first-seen order", () => {
    const rows = [
      row("a", { status: "todo" }),
      row("b", { status: "done" }),
      row("c", { status: "todo" }),
    ];
    const groups = groupRows(rows, "status");
    expect(groups.map((g) => g.value)).toEqual(["todo", "done"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("collects rows missing the field into one No-value bucket placed last", () => {
    const rows = [
      row("a", { status: "todo" }),
      row("b", {}),
      row("c", { status: null }),
      row("d", { status: "" }),
    ];
    const groups = groupRows(rows, "status");
    expect(groups.map((g) => g.key)).toEqual([groupKey("todo"), EMPTY_GROUP_KEY]);
    expect(groups[1].value).toBeNull();
    expect(labels(groups)).toEqual(["todo", "No value"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["b", "c", "d"]);
  });

  it("groups by a built-in field (slug)", () => {
    const rows = [row("a", {}, { slug: "x" }), row("b", {}, { slug: "x" }), row("c", {}, { slug: "y" })];
    const groups = groupRows(rows, "slug");
    expect(groups.map((g) => g.value)).toEqual(["x", "y"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("orders groups by the declared option sequence, not row order", () => {
    // Rows arrive Won-first then Lead — first-seen order would shuffle the
    // pipeline. With declared options the groups follow Lead → Qualified → Won.
    const rows = [
      row("a", { stage: "Won" }),
      row("b", { stage: "Lead" }),
      row("c", { stage: "Qualified" }),
      row("d", { stage: "Lead" }),
    ];
    const groups = groupRows(rows, "stage", ["Lead", "Qualified", "Won"]);
    expect(labels(groups)).toEqual(["Lead", "Qualified", "Won"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("puts undeclared values after declared options (first-seen) and No value last", () => {
    const rows = [
      row("a", { stage: "Stale" }), // not in options
      row("b", { stage: "Won" }),
      row("c", {}), // no value
      row("d", { stage: "Lead" }),
      row("e", { stage: "Old" }), // not in options, seen after Stale
    ];
    const groups = groupRows(rows, "stage", ["Lead", "Qualified", "Won"]);
    expect(labels(groups)).toEqual(["Lead", "Won", "Stale", "Old", "No value"]);
  });

  it("falls back to first-seen order when no options are declared", () => {
    const rows = [row("a", { stage: "Won" }), row("b", { stage: "Lead" })];
    expect(labels(groupRows(rows, "stage"))).toEqual(["Won", "Lead"]);
    expect(labels(groupRows(rows, "stage", null))).toEqual(["Won", "Lead"]);
  });

  // D78: Table / List used first-seen order and ignored the declared options,
  // so a view sorted by title showed done|todo|doing while Kanban showed
  // todo|doing|done.
  it("follows declared options even when the view's sort puts another value first", () => {
    const rows = [
      row("A", { status: "done" }, { title: "A" }),
      row("B", { status: "todo" }, { title: "B" }),
      row("C", { status: "doing" }, { title: "C" }),
    ];
    expect(labels(groupRows(rows, "status", ["todo", "doing", "done"]))).toEqual(["todo", "doing", "done"]);
  });

  // D78: Table / List keyed the empty bucket "(none)", so a row whose value
  // IS the text "(none)" merged into it.
  it("keeps a literal \"(none)\" value apart from the empty bucket", () => {
    const rows = [
      row("a", { status: "(none)" }),
      row("b", {}),
      row("c", { status: EMPTY_GROUP_KEY }),
    ];
    const groups = groupRows(rows, "status");
    expect(groups.map((g) => g.value)).toEqual(["(none)", EMPTY_GROUP_KEY, null]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([["a"], ["c"], ["b"]]);
  });
});

describe("fieldValue", () => {
  it("reads built-ins from the row and the rest from attributes, empty → null", () => {
    const r = row("a", { status: "todo", blank: "", title: "attr-title" }, { title: "Real" });
    expect(fieldValue(r, "title")).toBe("Real");
    expect(fieldValue(r, "slug")).toBe("s-a");
    expect(fieldValue(r, "status")).toBe("todo");
    expect(fieldValue(r, "blank")).toBeNull();
    expect(fieldValue(r, "missing")).toBeNull();
    expect(fieldValue(r, "created_at")).toBeNull();
    expect(BUILT_IN_FIELDS.has("sort_order")).toBe(true);
  });
});

describe("aggregateField", () => {
  it("counts only present (non-empty) values", () => {
    const rows = [row("a", { price: "10" }), row("b", {}), row("c", { price: "" })];
    expect(aggregateField(rows, "price").count).toBe(1);
  });

  it("sums and averages when every present value is numeric", () => {
    const rows = [row("a", { price: "10" }), row("b", { price: "20" }), row("c", { price: "30" })];
    const agg = aggregateField(rows, "price");
    expect(agg.count).toBe(3);
    expect(agg.sum).toBe(60);
    expect(agg.avg).toBe(20);
  });

  it("omits sum/avg when any present value is non-numeric", () => {
    const rows = [row("a", { price: "10" }), row("b", { price: "n/a" })];
    const agg = aggregateField(rows, "price");
    expect(agg.count).toBe(2);
    expect(agg.sum).toBeUndefined();
    expect(agg.avg).toBeUndefined();
  });

  it("returns count 0 and no sum for an all-empty column", () => {
    const rows = [row("a", {}), row("b", { price: "" })];
    expect(aggregateField(rows, "price")).toEqual({ count: 0 });
  });

  // D50: the footer reads numbers like the rollup, sorts and filters do.
  it("sums only stored numbers on a number column, skipping 2h / 1e3 / NaN", () => {
    const rows = [
      row("a", { hours: "3" }), row("b", { hours: "4.5" }), row("c", { hours: "2h" }),
      row("d", { hours: "1e3" }), row("e", { hours: "NaN" }),
    ];
    const agg = aggregateField(rows, "hours", "number");
    expect(agg).toEqual({ count: 5, sum: 7.5, avg: 3.75 });
    expect(formatFooter(agg)).toBe("Σ 7.5 · avg 3.75");
  });

  it("never sums a column of another storage type", () => {
    const rows = [row("a", { code: "10" }), row("b", { code: "20" })];
    expect(aggregateField(rows, "code", "text")).toEqual({ count: 2 });
  });

  it("with no known type, an exponent or NaN is no number", () => {
    expect(aggregateField([row("a", { x: "1e3" })], "x")).toEqual({ count: 1 });
    expect(aggregateField([row("a", { x: "NaN" })], "x")).toEqual({ count: 1 });
    expect(aggregateField([row("a", { x: " 5" })], "x")).toEqual({ count: 1 });
  });
});

describe("formatFooter", () => {
  it("shows both sum and average for a numeric column", () => {
    const rows = [row("a", { reps: "10" }), row("b", { reps: "20" }), row("c", { reps: "30" })];
    expect(formatFooter(aggregateField(rows, "reps"))).toBe("Σ 60 · avg 20");
  });

  it("rounds non-integer sum and average to 2 decimals", () => {
    const rows = [row("a", { w: "1" }), row("b", { w: "2" }), row("c", { w: "2" })];
    // sum 5, avg 1.6667 → 1.67
    expect(formatFooter(aggregateField(rows, "w"))).toBe("Σ 5 · avg 1.67");
  });

  it("falls back to a value count for a non-numeric column", () => {
    const rows = [row("a", { mood: "good" }), row("b", { mood: "ok" })];
    expect(formatFooter(aggregateField(rows, "mood"))).toBe("2 values");
  });

  it("renders nothing for an all-empty column", () => {
    const rows = [row("a", {}), row("b", { x: "" })];
    expect(formatFooter(aggregateField(rows, "x"))).toBe("");
  });
});

describe("a list attribute (multi-value, D117)", () => {
  it("groups a row under each of its elements, and the plain value as before", () => {
    const rows = [
      row("a", { topics: '["ml","db"]' }),
      row("b", { topics: "ml" }),
      row("c", { topics: '["db","db"]' }),
      row("d", { topics: "[]" }),
      row("e", {}),
    ];
    const groups = groupRows(rows, "topics");
    expect(groups.map((g) => [g.value, g.rows.map((r) => r.id)])).toEqual([
      ["ml", ["a", "b"]],
      ["db", ["a", "c"]],
      [null, ["d", "e"]],
    ]);
  });

  it("orders element groups by the declared options", () => {
    const groups = groupRows([row("a", { topics: '["db","ml"]' })], "topics", ["ml", "db"]);
    expect(groups.map((g) => g.value)).toEqual(["ml", "db"]);
  });

  it("a value that only starts with [ is one value", () => {
    expect(groupRows([row("a", { topics: "[draft" })], "topics").map((g) => g.value)).toEqual(["[draft"]);
  });

  it("fieldValues lists a row's elements once each", () => {
    expect(fieldValues(row("a", { topics: '["ml","","ml","db"]' }), "topics")).toEqual(["ml", "db"]);
    expect(fieldValues(row("a", {}, { title: "T" }), "title")).toEqual(["T"]);
    expect(fieldValues(row("a", {}), "topics")).toEqual([]);
  });
});

describe("movedValue (a card moves between columns of a list field)", () => {
  it("swaps the column it leaves for the one it enters, keeping the other elements", () => {
    expect(movedValue('["ml","db"]', "ml", "web")).toBe('["db","web"]');
    expect(movedValue('["ml","db"]', "ml", "db")).toBe('["db"]'); // already there
    expect(movedValue('["ml","db"]', "ml", null)).toBe('["db"]'); // to the No-value column
    expect(movedValue('["ml"]', "ml", null)).toBe("");
    expect(movedValue('["ml"]', null, "db")).toBe('["ml","db"]'); // from the No-value column
  });

  it("a single value is replaced, as before", () => {
    expect(movedValue("ml", "ml", "db")).toBe("db");
    expect(movedValue("ml", "ml", null)).toBe("");
    expect(movedValue(undefined, null, "db")).toBe("db");
  });
});
