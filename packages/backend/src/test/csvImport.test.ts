// CSV import parser (modules/importers/csv/import.ts) — pure unit coverage. The import
// route turns each data row into one node (columns → node_attributes), so the
// parser must correctly handle the messy shapes real exports produce: quoted
// fields with embedded commas/newlines, "" escaped quotes, CRLF line endings,
// a UTF-8 BOM (Excel), blank rows, and a final row with no trailing newline.

import { describe, it, expect } from "vitest";
import { parseCsv } from "../modules/importers/csv/import.js";

describe("parseCsv", () => {
  it("parses a simple header + rows", () => {
    const t = parseCsv("Name,Status\nAlpha,Done\nBeta,Todo")!;
    expect(t.header).toEqual(["Name", "Status"]);
    expect(t.rows).toEqual([["Alpha", "Done"], ["Beta", "Todo"]]);
  });

  it("handles quoted fields with embedded commas and newlines", () => {
    const t = parseCsv('Title,Body\n"Hello, world","line1\nline2"')!;
    expect(t.rows[0]).toEqual(["Hello, world", "line1\nline2"]);
  });

  it("handles escaped double-quotes (\"\")", () => {
    const t = parseCsv('Q\n"She said ""hi"""')!;
    expect(t.rows[0]).toEqual(['She said "hi"']);
  });

  it("normalizes CRLF line endings", () => {
    const t = parseCsv("A,B\r\n1,2\r\n3,4")!;
    expect(t.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("strips a UTF-8 BOM from the first header cell", () => {
    const t = parseCsv("﻿Name,Status\nA,B")!;
    expect(t.header).toEqual(["Name", "Status"]);
  });

  it("drops fully-blank rows", () => {
    const t = parseCsv("A,B\n1,2\n\n,\n3,4")!;
    expect(t.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("captures a final row with no trailing newline", () => {
    const t = parseCsv("A\nlast")!;
    expect(t.rows).toEqual([["last"]]);
  });

  it("returns null for empty input", () => {
    expect(parseCsv("")).toBeNull();
    expect(parseCsv("\n\n")).toBeNull();
  });
});

describe("CSV line endings", () => {
  it("a lone \\r ends a row like \\n and \\r\\n", () => {
    const expected = { header: ["Name", "Status"], rows: [["A", "Open"], ["B", "Done"]] };
    expect(parseCsv("Name,Status\rA,Open\rB,Done\r")).toEqual(expected);
    expect(parseCsv("Name,Status\r\nA,Open\r\nB,Done\r\n")).toEqual(expected);
    expect(parseCsv("Name,Status\nA,Open\nB,Done\n")).toEqual(expected);
  });
  it("keeps a \\r inside a quoted cell", () => {
    expect(parseCsv('Name\r"a\rb"\r')!.rows).toEqual([["a\rb"]]);
  });
});
