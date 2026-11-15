import { describe, it, expect } from "vitest";
import { numericValueSql } from "../services/attributeNumber.js";
import { appendFilterClauses, BUILT_IN_FIELDS, type FilterClause } from "../services/filter/sqlClauses.js";

// The shared filter-clause SQL compiler (unifies executeView + onden-query).
// Pure string/param building — assert the generated SQL + parameter list.

function compile(filters: FilterClause[], alias = "n", startParams: unknown[] = ["ws"]) {
  const where: string[] = [];
  const params = [...startParams];
  appendFilterClauses(filters, where, params, alias);
  return { where, params };
}

describe("appendFilterClauses — one operator set for the SQL query paths", () => {
  it("built-in columns filter directly on the aliased table", () => {
    const { where, params } = compile([{ field: "title", op: "eq", value: "Hi" }]);
    expect(where).toEqual(["n.title = $2"]);
    expect(params).toEqual(["ws", "Hi"]);
    expect(BUILT_IN_FIELDS.has("title")).toBe(true);
  });

  it("contains becomes a wrapped ILIKE; empty/nempty take no value param", () => {
    expect(compile([{ field: "title", op: "contains", value: "ka" }]).params).toEqual(["ws", "%ka%"]);
    const empty = compile([{ field: "slug", op: "empty" }]);
    expect(empty.params).toEqual(["ws"]); // no value pushed
    expect(empty.where[0]).toContain("IS NULL OR");
  });

  it("attribute fields use a correlated EXISTS keyed on the alias", () => {
    const { where, params } = compile([{ field: "status", op: "eq", value: "reading" }]);
    expect(where[0]).toContain("EXISTS (SELECT 1 FROM node_attributes na");
    expect(where[0]).toContain("na.node_id = n.id");
    expect(where[0]).toContain("na.key = $2");
    expect(where[0]).toContain("na.value = $3");
    expect(where[0]).toContain("el.v = $3"); // a list matches by element (D117)
    expect(params).toEqual(["ws", "status", "reading"]);
  });

  it("attribute ne is NOT EXISTS (missing attr is not the value)", () => {
    expect(compile([{ field: "status", op: "ne", value: "done" }]).where[0]).toMatch(/^NOT EXISTS/);
  });

  it("built-in range ops cast typed columns to their column type", () => {
    // Round-1 casts the (text) param to the built-in column's type
    // (updated_at/created_at → timestamptz, sort_order → numeric) so the
    // comparison uses the column's native ordering, not lexicographic text.
    const { where, params } = compile([{ field: "updated_at", op: "gte", value: "2020-01-01" }]);
    expect(where).toEqual(["n.updated_at >= $2::timestamptz"]);
    expect(params).toEqual(["ws", "2020-01-01"]);
    expect(compile([{ field: "created_at", op: "lt", value: "2025-06-01T10:00:00Z" }]).where[0]).toBe("n.created_at < $2::timestamptz");
  });

  it("attribute range op is value_type-aware (numeric VALUE → numeric arm only)", () => {
    const { where, params } = compile([{ field: "year", op: "gte", value: "2020" }]);
    // The arm is chosen by the comparison value's format at build time: "2020"
    // is numeric → emit ONLY the numeric arm (regex-guarded ::numeric). The
    // value is cast exactly once, via ::text first, so the placeholder type can't
    // be inferred timestamptz. No date arm is emitted (it would constant-fold
    // "2020"::timestamptz and 500). Row-side guard still drops mistyped values.
    expect(where[0]).toContain("na.value_type = 'number'");
    expect(where[0]).toContain(`${numericValueSql("na")} >= ($3::text)::numeric`);
    expect(where[0]).not.toContain("timestamptz");
    expect(params).toEqual(["ws", "year", "2020"]);
  });

  it("attribute range op picks the date arm for a date-shaped VALUE (::timestamptz)", () => {
    const { where, params } = compile([{ field: "due", op: "lt", value: "2026-06-13" }]);
    // Date-shaped value → ONLY the timestamptz arm; no numeric arm (which would
    // constant-fold "2026-06-13"::numeric and 500).
    expect(where[0]).toContain("na.value_type = 'date'");
    expect(where[0]).toContain("END) < ($3::text)::timestamptz");
    expect(where[0]).not.toContain("::numeric");
    expect(params).toEqual(["ws", "due", "2026-06-13"]);
  });

  it("attribute range op with a date-shaped value that is no date matches nothing (FALSE), as compareAttribute does", () => {
    for (const value of ["2026-11-31", "2026-02-30", "2026-11-14abc", "2026-13-01"]) {
      const { where, params } = compile([{ field: "due", op: "gte", value }]);
      expect(where, value).toEqual(["FALSE"]);
      expect(params, value).toEqual(["ws"]);
    }
  });

  it("the stored date is read inside a CASE behind pg_input_is_valid, not guarded beside the cast", () => {
    const { where } = compile([{ field: "due", op: "lt", value: "2026-06-13" }]);
    expect(where[0]).toMatch(/CASE WHEN na\.value_type = 'date'[^)]*AND pg_input_is_valid\(na\.value, 'timestamptz'\) THEN na\.value::timestamptz END/);
    expect(where[0]).not.toMatch(/AND na\.value::timestamptz/);
  });

  it("attribute range op with an unparseable value matches nothing (FALSE)", () => {
    const { where, params } = compile([{ field: "year", op: "gte", value: "not-a-number" }]);
    expect(where[0]).toBe("FALSE");
    // Neither the key nor the value is bound — no arm reads them, and a param
    // the statement never uses makes Postgres refuse it (D49 parity fixture).
    expect(params).toEqual(["ws"]);
  });

  it("honours the alias + continues parameter numbering from the caller", () => {
    const { where, params } = compile(
      [{ field: "status", op: "eq", value: "x" }],
      "cn",
      ["ws", ["tag-a"]], // caller already used $1, $2
    );
    expect(where[0]).toContain("na.node_id = cn.id");
    expect(where[0]).toContain("na.key = $3");
    expect(where[0]).toContain("na.value = $4");
    expect(params).toEqual(["ws", ["tag-a"], "status", "x"]);
  });

  it("a typed built-in compared with a value its type cannot take matches nothing instead of failing the cast", () => {
    // A view saved before the check, or an onden-query block: the
    // ::timestamptz / ::numeric cast used to 500 every run (D118 small 3).
    for (const clause of [
      { field: "updated_at", op: "gt", value: "2026-13-01" },
      { field: "created_at", op: "lte", value: "yesterday" },
      { field: "updated_at", op: "eq", value: "2026-02-30" },
      { field: "sort_order", op: "gte", value: "ten" },
      { field: "updated_at", op: "lt", value: "" },
    ] as FilterClause[]) {
      expect(compile([clause]), JSON.stringify(clause)).toEqual({ where: ["FALSE"], params: ["ws"] });
    }
    // ne: nothing equals it, so every row stays.
    expect(compile([{ field: "created_at", op: "ne", value: "soon" }])).toEqual({ where: ["TRUE"], params: ["ws"] });
    // A real value still casts once; text columns and contains are untouched.
    expect(compile([{ field: "sort_order", op: "gt", value: "-1.5" }]).where).toEqual(["n.sort_order > $2::numeric"]);
    expect(compile([{ field: "updated_at", op: "eq", value: "2026-10-01" }]).where).toEqual(["n.updated_at = $2::timestamptz"]);
    expect(compile([{ field: "updated_at", op: "contains", value: "2026-13" }]).where).toEqual(["n.updated_at::text ILIKE $2"]);
    expect(compile([{ field: "title", op: "gt", value: "2026-13-01" }]).where).toEqual(["n.title > $2"]);
  });

});
