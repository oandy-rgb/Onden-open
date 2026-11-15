// Deep CSV/Notion database import — pure derivation coverage
// (modules/importers/csv/database.ts). The orchestrator turns a CSV table into a
// typed collection schema + one item per row; everything db-free is tested
// here so the type inference, Notion-id dedup, page-id parsing, and the
// double-export `_all.csv` dedup are pinned without a Postgres round-trip.

import { describe, it, expect } from "vitest";
import { parseCsv } from "../modules/importers/csv/import.js";
import {
  inferColumnType,
  inferSchemaFields,
  defaultViews,
  rowToItem,
  parseNotionId,
  cleanNotionTitle,
  dedupNotionCsvFiles,
  collectionNameFromCsvPath,
} from "../modules/importers/csv/database.js";

describe("inferColumnType", () => {
  it("infers number when every value is a number as a typed one is stored", () => {
    expect(inferColumnType(["1", "-2", "3.5", " 7 "]).type).toBe("number");
    // Notion's "Number with commas": a strict thousands grouping is undone;
    // anything else with a comma ("1,5", "1,20") keeps the column text
    expect(inferColumnType(["1", "1,200", "-12,345.6"]).type).toBe("number");
    expect(inferColumnType(["1", "1,5"]).type).toBe("text");
    expect(inferColumnType(["1", "1,20"]).type).toBe("text");
  });
  it("infers date for ISO and Notion's written dates", () => {
    expect(inferColumnType(["2026-01-02", "2026-03-04T10:00"]).type).toBe("date");
    expect(inferColumnType(["March 5, 2026", "April 1, 2026"]).type).toBe("date");
    expect(inferColumnType(["October 16, 2026 3:04 PM", "10/16/2026", "2026/10/17"]).type).toBe("date");
  });
  it("does not make a date column of impossible or annotated dates", () => {
    expect(inferColumnType(["2026-10-16", "2026-02-30"]).type).toBe("text");
    expect(inferColumnType(["2026-10-16", "2026-10-16 (draft)"]).type).toBe("text");
    expect(inferColumnType(["2026", "2027"]).type).toBe("number");
  });
  it("infers boolean for yes/no/checked", () => {
    expect(inferColumnType(["Yes", "No", "Yes"]).type).toBe("boolean");
  });
  it("infers select for a small repeating vocabulary", () => {
    const r = inferColumnType(["Todo", "Done", "Todo", "Doing", "Done"]);
    expect(r.type).toBe("select");
    expect(r.options).toEqual(["Todo", "Done", "Doing"]);
  });
  it("stays text for unique free-text values", () => {
    expect(inferColumnType(["a long note", "another distinct note", "yet more"]).type).toBe("text");
  });
  it("defaults empty columns to text", () => {
    expect(inferColumnType(["", "", ""]).type).toBe("text");
  });
  it("does not call a single distinct value a select", () => {
    // every value identical → distinct.size (1) is NOT < count, so it's text,
    // not a degenerate one-option select
    expect(inferColumnType(["x", "x", "x"]).type).toBe("text");
  });
});

describe("inferSchemaFields", () => {
  it("types each column and de-dupes colliding headers", () => {
    const table = parseCsv("Name,Status,Tags,Tags\nA,Todo,x,y\nB,Done,x,z\nC,Todo,x,y")!;
    const fields = inferSchemaFields(table);
    expect(fields.map((f) => f.name)).toEqual(["Name", "Status", "Tags", "Tags 2"]);
    expect(fields.find((f) => f.name === "Status")!.type).toBe("select");
  });
  it("skips blank-header columns", () => {
    const table = parseCsv("Name,,Status\nA,junk,Todo")!;
    expect(inferSchemaFields(table).map((f) => f.name)).toEqual(["Name", "Status"]);
  });
});

describe("defaultViews", () => {
  it("picks a title, a group (select), and a date field", () => {
    const fields = inferSchemaFields(parseCsv("Name,Status,Due\nA,Todo,2026-01-01\nB,Done,2026-02-01\nC,Todo,2026-03-01")!);
    const v = defaultViews(fields);
    expect(v.title_field).toBe("Name");
    expect(v.group_field).toBe("Status");
    expect(v.date_field).toBe("Due");
  });
});

describe("rowToItem", () => {
  it("coerces cells to the field type and titles by first non-empty cell", () => {
    const fields = inferSchemaFields(parseCsv("Name,Count,Done\nAlpha,3,Yes\nBeta,5,No")!);
    const table = parseCsv("Name,Count,Done\nAlpha,3,Yes")!;
    const item = rowToItem(fields, table.header, table.rows[0]!);
    expect(item.title).toBe("Alpha");
    expect(item.data).toEqual({ Name: "Alpha", Count: "3", Done: true });
  });
  it("stores Notion's dates as the YYYY-MM-DD a date field holds", () => {
    const table = parseCsv('Name,Due,Done\nA,"October 16, 2026",No\nB,10/16/2026,Yes\nC,"October 16, 2026 3:04 PM",\nD,,No')!;
    const fields = inferSchemaFields(table);
    expect(fields.map((f) => f.type)).toEqual(["text", "date", "boolean"]);
    expect(table.rows.map((r) => rowToItem(fields, table.header, r).data)).toEqual([
      { Name: "A", Due: "2026-10-16", Done: false },
      { Name: "B", Due: "2026-10-16", Done: true },
      { Name: "C", Due: "2026-10-16" },
      { Name: "D", Done: false },
    ]);
  });
  it("keeps a slash-date column as text when nothing says which part is the month", () => {
    const table = parseCsv("Name,Due\nA,03/04/2026\nB,05/06/2026")!;
    const [, due] = inferSchemaFields(table);
    expect(due).toEqual({ name: "Due", type: "text", ambiguousDate: true });
    // One value with a part above 12 in second place settles month-first.
    expect(inferSchemaFields(parseCsv("Name,Due\nA,03/04/2026\nB,05/16/2026")!)[1]).toEqual({ name: "Due", type: "date" });
    // Same-valued parts read the same either way.
    expect(inferSchemaFields(parseCsv("Name,Due\nA,03/03/2026")!)[1]).toEqual({ name: "Due", type: "date" });
  });
  it("parses the trailing Notion page id for dedup", () => {
    const fields = inferSchemaFields(parseCsv("Name\nTask aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")!);
    const table = parseCsv("Name\nTask aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")!;
    const item = rowToItem(fields, table.header, table.rows[0]!);
    expect(item.notionId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("parseNotionId / cleanNotionTitle", () => {
  it("extracts a 32-hex page id and strips it from the title", () => {
    const t = "My Task 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    expect(parseNotionId(t)).toBe("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d");
    expect(cleanNotionTitle(t)).toBe("My Task");
  });
  it("returns null + identity when there is no hash suffix", () => {
    expect(parseNotionId("Plain Title")).toBeNull();
    expect(cleanNotionTitle("Plain Title")).toBe("Plain Title");
  });
});

describe("dedupNotionCsvFiles", () => {
  it("prefers <DB>_all.csv and drops its plain sibling", () => {
    const kept = dedupNotionCsvFiles(["Tasks abc.csv", "Tasks abc_all.csv"]);
    expect(kept).toEqual(["Tasks abc_all.csv"]);
  });
  it("keeps a plain csv when there is no _all sibling", () => {
    expect(dedupNotionCsvFiles(["Notes.csv"])).toEqual(["Notes.csv"]);
  });
  it("keeps unrelated databases independently", () => {
    const kept = dedupNotionCsvFiles(["A.csv", "A_all.csv", "B.csv"]).sort();
    expect(kept).toEqual(["A_all.csv", "B.csv"]);
  });
});

describe("collectionNameFromCsvPath", () => {
  it("strips path, extension, _all, and the Notion hash", () => {
    expect(collectionNameFromCsvPath("export/Tasks 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d_all.csv")).toBe("Tasks");
    expect(collectionNameFromCsvPath("Reading List.csv")).toBe("Reading List");
  });
});
