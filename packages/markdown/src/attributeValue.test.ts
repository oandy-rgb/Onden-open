import { describe, expect, it } from "vitest";
import {
  NUMBER_PATTERN, isStoredNumber, storedNumber, fieldViolation, freeFormType, governingField, inferFieldType, inferFromValue, isCalendarDate, normalize,
  parseValue, serializeValue, storageType, toCalendarDate, calendarDayOf, storedValueType, compareAttribute, compareAttributeOrder,
} from "./attributeValue.js";

describe("storageType", () => {
  it("maps each field type to its storage bucket", () => {
    expect(storageType("number")).toBe("number");
    expect(storageType("rating")).toBe("number"); // stars sort and filter as numbers
    expect(storageType("boolean")).toBe("bool");
    expect(storageType("date")).toBe("date");
    expect(storageType("relation")).toBe("node_ref");
    for (const t of ["text", "textarea", "richtext", "select", "media", "unknown", undefined]) {
      expect(storageType(t)).toBe("text");
    }
  });
});

describe("isCalendarDate", () => {
  it("accepts real calendar days, with or without a time", () => {
    for (const s of ["2026-06-09", "2024-02-29", "2026-06-09T10:30", "2026-06-09 10:30", "2026-06-09T10:30:00Z",
      "2026-06-09T10:30:00.123+08:00", "2026-06-09T23:59:59-0500", "2026-06-09T10:00+15:59", "2026-06-09T10:00-1559"]) {
      expect(isCalendarDate(s), s).toBe(true);
    }
  });
  it("refuses impossible days and times, and other shapes", () => {
    for (const s of ["2026-13-45", "2026-02-30", "2026-02-29", "2026-00-10", "2026-06-09T25:00", "2026-06-09T10:61",
      "2026-6-1", "ver-2026-06-01", "hello 2026-06-01", "2026-06-09 foo", "2026-06-09T10", "",
      // zones Postgres refuses to cast ("time zone displacement out of range")
      "2026-06-09T10:00+16:00", "2026-06-09T10:00+05:99", "2026-06-09T10:00+9999"]) {
      expect(isCalendarDate(s), s).toBe(false);
    }
  });
});

describe("toCalendarDate", () => {
  it("reads ISO dates and the written forms other apps export as YYYY-MM-DD", () => {
    const cases: Array<[string, string]> = [
      ["2026-10-16", "2026-10-16"],
      [" 2026-10-16 ", "2026-10-16"],
      ["2026-10-16T15:04:05Z", "2026-10-16"],
      ["October 16, 2026", "2026-10-16"],
      ["october 6, 2026", "2026-10-06"],
      ["Oct 16, 2026", "2026-10-16"],
      ["Sept. 1, 2026", "2026-09-01"],
      ["October 16, 2026 3:04 PM", "2026-10-16"],
      ["October 16, 2026 12:00am", "2026-10-16"],
      ["October 16, 2026 15:04", "2026-10-16"],
      ["February 29, 2024", "2024-02-29"],
      ["10/16/2026", "2026-10-16"],
      ["1/2/2026", "2026-01-02"],
      ["1/2/2026 9:30 AM", "2026-01-02"],
      ["2026/10/16", "2026-10-16"],
    ];
    for (const [text, iso] of cases) expect(toCalendarDate(text), text).toBe(iso);
  });
  it("refuses impossible days and times, day-first dates and other shapes", () => {
    for (const s of ["", "2026-02-30", "2026-10-16 (draft)", "February 30, 2026", "Octobre 16, 2026", "Smarch 1, 2026",
      "October 16 2026", "October 16, 26", "16/10/2026", "13/01/2026", "10/16/26", "2026/13/01",
      "October 16, 2026 13:00 PM", "October 16, 2026 0:30 AM", "October 16, 2026 24:00", "October 16, 2026 3:60 PM",
      "October 16, 2026 → October 20, 2026", "1,200", "2026", "yes"]) {
      expect(toCalendarDate(s), s).toBeNull();
    }
  });
  it("stays linear on long non-dates", () => {
    const time = (n: number) => {
      const inputs = ["a".repeat(n), "1/".repeat(n), "October 16, 2026 " + "1".repeat(n), "2026-10-16" + "0".repeat(n)];
      const started = performance.now();
      for (const s of inputs) toCalendarDate(s);
      return performance.now() - started;
    };
    time(1000); // warm up
    expect(time(200_000)).toBeLessThan(500);
  });
});

describe("calendarDayOf", () => {
  it("reads only calendar days — values Date.parse accepts but that name no day are null", () => {
    for (const s of ["10", "Draft 2", "", "  ", "garbage", "2026-02-30"]) expect(calendarDayOf(s, "UTC"), s).toBeNull();
    expect(calendarDayOf(null)).toBeNull();
    expect(calendarDayOf(undefined)).toBeNull();
  });
  it("a date, wall-clock time or written date names its own day in any zone", () => {
    for (const zone of ["Asia/Taipei", "UTC", "America/Los_Angeles"]) {
      expect(calendarDayOf("2026-10-14", zone)).toBe("2026-10-14");
      expect(calendarDayOf("2026-10-14T00:30", zone)).toBe("2026-10-14");
      expect(calendarDayOf("2026-10-14 23:59", zone)).toBe("2026-10-14");
      expect(calendarDayOf("2026/10/14", zone)).toBe("2026-10-14");
      expect(calendarDayOf("Oct 14, 2026", zone)).toBe("2026-10-14");
    }
  });
  it("a zoned instant lands on its day in the given zone", () => {
    // 16:30 UTC is 00:30 the next day in Taipei (+08:00).
    expect(calendarDayOf("2026-10-13T16:30:00Z", "UTC")).toBe("2026-10-13");
    expect(calendarDayOf("2026-10-13T16:30:00Z", "Asia/Taipei")).toBe("2026-10-14");
    expect(calendarDayOf("2026-10-13T15:59:59.999Z", "Asia/Taipei")).toBe("2026-10-13");
    // The value's own offset is honoured.
    expect(calendarDayOf("2026-10-14T00:30:00+08:00", "Asia/Taipei")).toBe("2026-10-14");
    expect(calendarDayOf("2026-10-14T00:30:00+0800", "UTC")).toBe("2026-10-13");
    expect(calendarDayOf("2026-10-13T20:00:00-05:00", "Asia/Taipei")).toBe("2026-10-14");
    expect(calendarDayOf("2026-10-14 03:00Z", "America/Los_Angeles")).toBe("2026-10-13");
  });
});

describe("fieldViolation", () => {
  it("checks each typed field", () => {
    expect(fieldViolation({ name: "n", type: "number" }, "3.5")).toBeNull();
    expect(fieldViolation({ name: "n", type: "number" }, "abc")).toMatch(/number/);
    // Exactly the SQL guard's grammar: what is typed as a number, typed reads see.
    for (const v of ["1e3", " 5 ", "0x10", "Infinity", "5.", ".5"]) {
      expect(fieldViolation({ name: "n", type: "number" }, v), v).toMatch(/number/);
    }
    expect(fieldViolation({ name: "r", type: "rating" }, "3.0")).toBeNull();
    expect(fieldViolation({ name: "r", type: "rating" }, " 3")).toMatch(/whole number/);
    expect(fieldViolation({ name: "r", type: "rating" }, "5")).toBeNull();
    expect(fieldViolation({ name: "r", type: "rating" }, "6")).toMatch(/5 stars or fewer/);
    expect(fieldViolation({ name: "r", type: "rating", max: 10 }, "6")).toBeNull();
    expect(fieldViolation({ name: "r", type: "rating" }, "2.5")).toMatch(/whole number/);
    expect(fieldViolation({ name: "b", type: "boolean" }, "yes")).toMatch(/true or false/);
    expect(fieldViolation({ name: "s", type: "select", options: ["a"] }, "b")).toMatch(/one of: a/);
    expect(fieldViolation({ name: "t", type: "text" }, "anything")).toBeNull();
  });
  it("uses the calendar date grammar (2026-13-45 is not a date)", () => {
    expect(fieldViolation({ name: "d", type: "date" }, "2026-10-16")).toBeNull();
    expect(fieldViolation({ name: "d", type: "date" }, "2026-13-45")).toMatch(/must be a date/);
  });
  it("refuses an empty value only for a required field", () => {
    expect(fieldViolation({ name: "n", type: "number" }, "")).toBeNull();
    expect(fieldViolation({ name: "n", type: "number", required: true }, "")).toMatch(/required/);
  });
});

describe("normalize", () => {
  it("stores a governed value under its field's type, whatever the hint", () => {
    expect(normalize({ name: "stars", type: "rating" }, "4", "text")).toEqual({ ok: true, value: "4", value_type: "number" });
    expect(normalize({ name: "due", type: "date" }, "2026-10-16", "text")).toEqual({ ok: true, value: "2026-10-16", value_type: "date" });
    expect(normalize({ name: "done", type: "boolean" }, "true")).toEqual({ ok: true, value: "true", value_type: "bool" });
  });
  it("refuses a value its field does not accept", () => {
    expect(normalize({ name: "due", type: "date" }, "2026-13-45")).toEqual({ ok: false, reason: expect.stringMatching(/date/) });
  });
  it("keeps the hint for a free-form key, else infers from the value", () => {
    expect(normalize(null, "2026-10-16", "text")).toEqual({ ok: true, value: "2026-10-16", value_type: "text" });
    expect(normalize(undefined, "42")).toEqual({ ok: true, value: "42", value_type: "number" });
    expect(normalize(undefined, "TBD")).toEqual({ ok: true, value: "TBD", value_type: "text" });
  });
  it("stores an empty value as text, also under a typed field", () => {
    expect(normalize({ name: "n", type: "number" }, "")).toEqual({ ok: true, value: "", value_type: "text" });
    expect(normalize({ name: "r", type: "relation" }, "")).toEqual({ ok: true, value: "", value_type: "text" });
    expect(normalize({ name: "r", type: "relation" }, "id-1")).toEqual({ ok: true, value: "id-1", value_type: "node_ref" });
  });
});

describe("governingField", () => {
  it("is the first field when all agree on the storage type", () => {
    const rating = { name: "s", type: "rating" }, number = { name: "s", type: "number" };
    expect(governingField([rating, number])).toBe(rating);
    expect(governingField([])).toBeNull();
  });
  it("is none when the fields disagree, whatever their order", () => {
    const date = { name: "due", type: "date" }, text = { name: "due", type: "text" };
    expect(governingField([date, text])).toBeNull();
    expect(governingField([text, date])).toBeNull();
  });
});

describe("NUMBER_PATTERN / freeFormType", () => {
  it("is the SQL guard's grammar", () => {
    expect(NUMBER_PATTERN).toBe("^-?[0-9]+(\\.[0-9]+)?$");
    expect(freeFormType("-3.5")).toBe("number");
    expect(freeFormType("2026-10-16")).toBe("date");
    expect(freeFormType("true")).toBe("bool");
    expect(freeFormType("TBD")).toBe("text");
    // Exactly as stored: a padded value is text, as the SQL guards read it.
    expect(freeFormType(" 5 ")).toBe("text");
    expect(freeFormType(" 2026-10-16 ")).toBe("text");
    expect(normalize(null, " 5 ")).toEqual({ ok: true, value: " 5 ", value_type: "text" });
    expect(normalize(null, " 5 ", "number")).toEqual({ ok: true, value: " 5 ", value_type: "text" });
  });
});

describe("isStoredNumber / storedNumber", () => {
  it("reads a number only when the value_type is number and the value is NUMBER_PATTERN", () => {
    expect(storedNumber("3", "number")).toBe(3);
    expect(storedNumber("-2.5", "number")).toBe(-2.5);
    for (const v of ["2h", "1e3", "NaN", "Infinity", " 3", "0x10", ""]) {
      expect(isStoredNumber(v, "number")).toBe(false);
      expect(storedNumber(v, "number")).toBeNull();
    }
    // A text-typed "3" is text.
    expect(isStoredNumber("3", "text")).toBe(false);
    // Unknown type: the pattern decides.
    expect(storedNumber("3")).toBe(3);
    expect(storedNumber("1e3")).toBeNull();
    expect(storedNumber(null)).toBeNull();
  });
});

describe("storedValueType", () => {
  it("is the governing field's storage type, else the free-form type", () => {
    expect(storedValueType("5", [{ name: "rating", type: "rating" }])).toBe("number");
    expect(storedValueType("5", [{ name: "code", type: "text" }])).toBe("text");
    // Fields that disagree on the storage type leave the key free-form.
    expect(storedValueType("5", [{ name: "x", type: "text" }, { name: "x", type: "number" }])).toBe("number");
    expect(storedValueType("2026-10-01", [])).toBe("date");
    expect(storedValueType("soon", [])).toBe("text");
    expect(storedValueType("", [{ name: "n", type: "number" }])).toBe("text");
  });
});

describe("compareAttribute (D49)", () => {
  it("equality: a number rhs equals a stored number, a string rhs the stored text", () => {
    expect(compareAttribute("5", "number", "==", 5)).toBe(true);
    expect(compareAttribute("5.0", "number", "==", 5)).toBe(false); // eq is text, as the server's
    expect(compareAttribute("5", "number", "!=", 5)).toBe(false);
    expect(compareAttribute("4", "number", "!=", 5)).toBe(true);
    // The stored text equals the literal's, as the server's eq compares.
    expect(compareAttribute("5", "text", "==", 5)).toBe(true);
    expect(compareAttribute("5.0", "text", "==", 5)).toBe(false); // a text-typed "5.0" is no number
    expect(compareAttribute("5", "number", "==", "5")).toBe(true);
    expect(compareAttribute("read", "text", "==", "read")).toBe(true);
    // Missing: equal to nothing, so != keeps the note (the server's NOT EXISTS).
    expect(compareAttribute(undefined, undefined, "==", 5)).toBe(false);
    expect(compareAttribute(undefined, undefined, "!=", 5)).toBe(true);
  });

  it("ranges pick the number or date arm by the rhs, like the SQL", () => {
    expect(compareAttribute("10", "number", ">", 9)).toBe(true);
    expect(compareAttribute("10", "number", ">", "9")).toBe(true);
    expect(compareAttribute("2h", "number", ">", 1)).toBe(false);
    expect(compareAttribute("10", "text", ">", 9)).toBe(false);
    expect(compareAttribute("2026-10-05", "date", ">=", "2026-10-01")).toBe(true);
    expect(compareAttribute("2026-10-01", "date", ">=", "2026-10-01")).toBe(true);
    expect(compareAttribute("2026-09-30", "date", ">=", "2026-10-01")).toBe(false);
    expect(compareAttribute("2026-10-01T10:00+08:00", "date", "<", "2026-10-01T03:00Z")).toBe(true);
    expect(compareAttribute("2026-10-05", "text", ">=", "2026-10-01")).toBe(false);
    expect(compareAttribute("2026-10-05", "date", ">=", 3)).toBe(false);
    // A text rhs matches nothing (no lexicographic arm), nor does a missing value.
    expect(compareAttribute("b", "text", ">", "a")).toBe(false);
    expect(compareAttribute(null, undefined, "<", 5)).toBe(false);
  });
});

describe("compareAttributeOrder (D49)", () => {
  const sort = (rows: Array<[string | undefined, string | undefined]>, dir: "asc" | "desc" = "asc") =>
    [...rows].sort((a, b) => compareAttributeOrder(a[0], a[1], b[0], b[1], dir)).map((r) => r[0]);
  it("numbers by value, then dates, then text; missing last both ways", () => {
    const rows: Array<[string | undefined, string | undefined]> = [
      ["10", "number"], [undefined, undefined], ["9", "number"], ["abc", "text"], ["2026-01-02", "date"],
    ];
    expect(sort(rows)).toEqual(["9", "10", "2026-01-02", "abc", undefined]);
    expect(sort(rows, "desc")).toEqual(["10", "9", "2026-01-02", "abc", undefined]);
  });
});

describe("inferFieldType", () => {
  it("infers number, date, boolean, else text", () => {
    expect(inferFieldType("")).toBe("text");
    expect(inferFieldType(" 7 ")).toBe("number");
    expect(inferFieldType("-3.14")).toBe("number");
    expect(inferFieldType("3,000")).toBe("text");
    expect(inferFieldType("2026-06-09 10:30")).toBe("date");
    expect(inferFieldType("2026-02-30")).toBe("text");
    expect(inferFieldType("true")).toBe("boolean");
    expect(inferFieldType("True")).toBe("text");
    expect(inferFieldType("https://example.com")).toBe("text");
  });
});

describe("inferFromValue", () => {
  it("keeps JS types and finds calendar-date strings", () => {
    expect(inferFromValue(42)).toBe("number");
    expect(inferFromValue(true)).toBe("bool");
    expect(inferFromValue("2026-06-01")).toBe("date");
    expect(inferFromValue("2026-06-01T12:34:56Z")).toBe("date");
    expect(inferFromValue("42")).toBe("text"); // a string stays a string
    expect(inferFromValue("2026-6-1")).toBe("text");
    expect(inferFromValue({ a: 1 })).toBe("text");
  });
  it("round-trips through serializeValue/parseValue", () => {
    for (const v of [0.25, -1.5, 35000, true, false, "殘差", "42", "2026-06-01", "color #ff6600 with spaces"]) {
      expect(parseValue(serializeValue(v), inferFromValue(v))).toBe(v);
    }
  });
});

describe("serializeValue / parseValue", () => {
  it("serializes JS values to stored strings", () => {
    expect(serializeValue(null)).toBe("");
    expect(serializeValue(undefined)).toBe("");
    expect(serializeValue(0)).toBe("0");
    expect(serializeValue(false)).toBe("false");
    expect(serializeValue([{ label: "Home", nodeId: "n1" }])).toBe('[{"label":"Home","nodeId":"n1"}]');
  });
  it("parses stored strings by type", () => {
    expect(parseValue("", "text")).toBeNull();
    expect(parseValue("", "number")).toBeNull();
    expect(parseValue("not-a-number", "number")).toBeNull();
    expect(parseValue("1", "bool")).toBe(true);
    expect(parseValue("yes", "bool")).toBe(false);
    expect(parseValue("uuid-here", "node_ref")).toBe("uuid-here");
  });
});
