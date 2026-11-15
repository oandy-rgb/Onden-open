// D117: the one codec of multi-value attributes, the write gate's per-element
// check of a "many" field, and the element match of ==/!=.
import { describe, expect, it } from "vitest";
import { attributeValues, compareAttribute, encodeValues, fieldViolation, isListValue, normalize, storedValueType } from "./attributeValue.js";

describe("attributeValues / encodeValues", () => {
  it("decodes a JSON array of scalars as its elements, anything else as one value", () => {
    expect(attributeValues('["ml","db"]')).toEqual(["ml", "db"]);
    expect(attributeValues("[1, true, null]")).toEqual(["1", "true", ""]);
    expect(attributeValues("[]")).toEqual([]);
    expect(attributeValues("ml")).toEqual(["ml"]);
    expect(attributeValues("")).toEqual([]);
    expect(attributeValues(null)).toEqual([]);
    expect(attributeValues("[draft")).toEqual(["[draft"]);
    expect(attributeValues('[{"a":1}]')).toEqual(['[{"a":1}]']);
    expect(attributeValues("[[Note]]")).toEqual(["[[Note]]"]); // a wikilink is one value
  });

  it("round-trips a list, and no values is the empty string", () => {
    for (const list of [["a"], ["a", "b, c"], ['quote "x"', "[[Link]]"]]) {
      expect(attributeValues(encodeValues(list))).toEqual(list);
      expect(isListValue(encodeValues(list))).toBe(true);
    }
    expect(encodeValues([])).toBe("");
    expect(isListValue("a")).toBe(false);
  });
});

describe("the write gate checks each element of a many field's list", () => {
  const topics = { name: "topics", type: "select", options: ["ml", "db"], cardinality: "many" as const };

  it("accepts a select list of options (the panel's first pick is ['ml'])", () => {
    expect(normalize(topics, '["ml"]')).toEqual({ ok: true, value: '["ml"]', value_type: "text" });
    expect(normalize(topics, '["ml","db"]').ok).toBe(true);
  });

  it("refuses a list holding a value the field refuses, naming it", () => {
    expect(fieldViolation(topics, '["ml","web"]')).toBe('"topics" must be one of: ml, db');
    expect(normalize({ name: "n", type: "number", cardinality: "many" }, '["1","x"]'))
      .toEqual({ ok: false, reason: '"n" must be a number' });
  });

  it("a single value under a many field is still one value", () => {
    expect(fieldViolation(topics, "ml")).toBeNull();
    expect(fieldViolation(topics, "web")).toBe('"topics" must be one of: ml, db');
  });

  it("number, rating and date lists can be saved, stored as text (typed reads skip lists)", () => {
    for (const [type, value] of [["number", '["1","2.5"]'], ["rating", '["3","5"]'], ["date", '["2026-10-20"]']] as const) {
      expect(normalize({ name: "f", type, cardinality: "many" }, value)).toEqual({ ok: true, value, value_type: "text" });
    }
    expect(normalize({ name: "r", type: "relation", cardinality: "many" }, '["id-a","id-b"]'))
      .toMatchObject({ ok: true, value_type: "node_ref" });
  });

  it("skips empty slots; a required field needs one value", () => {
    expect(fieldViolation(topics, '["ml",""]')).toBeNull();
    expect(fieldViolation({ ...topics, required: true }, '[""]')).toBe('"topics" is required');
    expect(fieldViolation({ ...topics, required: true }, "[]")).toBe('"topics" is required');
  });

  it("a single-value field is checked whole, as before", () => {
    expect(fieldViolation({ name: "status", type: "select", options: ["a"] }, '["a"]')).not.toBeNull();
    expect(fieldViolation({ name: "n", type: "number" }, '["1"]')).not.toBeNull();
  });

  it("the app reads the same storage type for a stored list", () => {
    expect(storedValueType('["1","2"]', [{ type: "number", cardinality: "many" }])).toBe("text");
    expect(storedValueType('["1"]', [{ type: "relation" }])).toBe("node_ref");
    expect(storedValueType("5", [{ type: "number" }])).toBe("number");
  });
});

describe("compareAttribute matches an element of a list", () => {
  it("== and != read a list's elements, and a '[draft' is plain text", () => {
    expect(compareAttribute('["Alice","Bob"]', "text", "==", "Alice")).toBe(true);
    expect(compareAttribute('["Alice","Bob"]', "text", "==", "Ali")).toBe(false);
    expect(compareAttribute('["Alice","Bob"]', "text", "!=", "Bob")).toBe(false);
    expect(compareAttribute('["Alice","Bob"]', "text", "!=", "Carol")).toBe(true);
    expect(compareAttribute('["1","2"]', "text", "==", 2)).toBe(true);
    expect(compareAttribute("[draft", "text", "==", "[draft")).toBe(true);
    expect(compareAttribute("[draft", "text", "==", "draft")).toBe(false);
  });
});

describe("Logseq 2.0.2 cross-check: a cleared slot in a many field", () => {
  it("an empty slot (a date cleared) survives the list codec without throwing", () => {
    expect(attributeValues(encodeValues(["", "2026-10-01"]))).toEqual(["", "2026-10-01"]);
    expect(attributeValues(encodeValues([""]))).toEqual([""]);
  });
});
