// Fuzz: the importers' pure layers (CSV, Notion database schema inference,
// Obsidian / Markdown folder paths and links, frontmatter) and the import
// request schema. Not run here: the parts that write to Postgres
// (importObsidian, importNotionDatabases, importObsidianFolders), which need a
// database with the app's extensions; their inputs are what these tests harden.
// Invariants: never throw, linear time, a path never leaves the import root,
// links are rewritten only to uploaded files, NUL and lone surrogates are
// refused with a reason. Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseCsv } from "../modules/importers/csv/import.js";
import {
  inferColumnType, inferSchemaFields, toCollectionField, defaultViews, rowToItem, parseNotionId, cleanNotionTitle, dedupNotionCsvFiles, collectionNameFromCsvPath,
} from "../modules/importers/csv/database.js";
import { importPath, importedImageLinks } from "../modules/importers/shared/imageLinks.js";
import { importedNoteContent } from "../modules/importers/markdown/note.js";
import { noteSizeProblem } from "@onden/markdown";
import { obsidianImportSchema } from "../modules/importers/obsidian/import.js";
import { vaultPaths, parentFolderOf, folderDepth } from "../services/vaultPath.js";
import { anyString, expectLinearGrowth, expectWithinBudget, fuzzParams, hostileInput, loadCorpus, mutated, soup } from "./fuzzSupport.js";

const csvCorpus = loadCorpus("csv");
const importCorpus = loadCorpus("import");
const csvText = hostileInput(csvCorpus);
const noteText = hostileInput(importCorpus);

describe("CSV and Notion database import", () => {
  it("parseCsv never throws; a table has string headers and non-blank string rows", () => {
    fc.assert(fc.property(csvText, (text) => {
      expectWithinBudget("parseCsv", text, 200, () => {
        const table = parseCsv(text);
        if (table === null) return;
        for (const h of table.header) expect(typeof h).toBe("string");
        for (const row of table.rows) {
          expect(row.some((cell) => cell.trim() !== "")).toBe(true);
          for (const cell of row) expect(typeof cell).toBe("string");
        }
      });
    }), fuzzParams(600));
  });

  it("schema inference and row conversion never throw on any table", () => {
    fc.assert(fc.property(csvText, (text) => {
      const table = parseCsv(text);
      fc.pre(table !== null && table.header.length > 0);
      const fields = inferSchemaFields(table!);
      const names = fields.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length); // header collisions are de-duplicated
      for (const name of names) expect(name.trim()).not.toBe("");
      fields.map(toCollectionField);
      defaultViews(fields);
      for (const row of table!.rows.slice(0, 50)) {
        const item = rowToItem(fields, table!.header, row);
        expect(typeof item.title === "string" || item.title === undefined).toBe(true);
      }
    }), fuzzParams(500));
  });

  it("column typing and file-name helpers never throw on any strings", () => {
    fc.assert(fc.property(fc.array(anyString, { maxLength: 30 }), anyString, fc.array(anyString, { maxLength: 8 }), (values, title, paths) => {
      inferColumnType(values);
      parseNotionId(title);
      expect(cleanNotionTitle(title).length === 0 ? title.trim() === "" : true).toBe(true);
      collectionNameFromCsvPath(title);
      const kept = dedupNotionCsvFiles(paths);
      for (const p of kept) expect(paths).toContain(p);
    }), fuzzParams(500));
  });

  it("repeated shapes grow linearly", () => {
    for (const unit of ['"', '""', ",", "a\r", "\n", ",\n", '"a\n', "a\n1,"]) {
      expectLinearGrowth(`parseCsv ${JSON.stringify(unit)}`, unit, (t) => { const table = parseCsv(t); if (table) inferSchemaFields(table); }, { n: 4000, fastMs: 40 });
    }
  });

  it("inferSchemaFields grows linearly in the number of identical column names", () => {
    // A header of 16000 columns named "a" (32 KB) took ~7.6 s: every duplicate restarted its " 2", " 3", …
    // search from 2. A Notion/CSV import of such a file kept the server busy.
    expectLinearGrowth("inferSchemaFields duplicate header", "a,", (t) => { const table = parseCsv(`${t}\n1`); if (table) inferSchemaFields(table); }, { n: 1500, fastMs: 40, pairs: 2 });
  });
});

describe("Obsidian and Markdown folder import", () => {
  it("importPath: a path either is refused or stays inside the import (no absolute, parent, backslash or control character)", () => {
    const pathish = fc.oneof(
      anyString,
      fc.array(fc.constantFrom("..", ".", "a", "b c", "課程", "", "%2e%2e", "C:", "\u0000", "\\", "x\ty"), { maxLength: 6 }).map((parts) => parts.join("/")),
      mutated({ a: "../../etc/passwd", b: "/abs", c: "a/./b/../../../x", d: "file:///x", e: "a\\b", f: "a//b///c" }),
    );
    fc.assert(fc.property(pathish, (raw) => {
      const path = importPath(raw);
      if (path === null) return;
      expect(path.startsWith("/")).toBe(false);
      expect(path.split("/")).not.toContain("..");
      expect(path).not.toMatch(/[\u0000-\u001f\\]/);
      expect(path).not.toBe("");
      expect(folderDepth(path)).toBeGreaterThanOrEqual(0);
      parentFolderOf(path);
    }), fuzzParams(2000));
  });

  it("vault paths: names never escape their folder, stay unique ignoring case, and cycles terminate", () => {
    const slug = fc.oneof(fc.constant(null), fc.constantFrom("", " ", "..", "...", ".trash", ".onden", "a/b", "a\\b", "../x", "A", "a", "課程"), anyString);
    const placements = fc.array(fc.record({ slug, parentIdx: fc.option(fc.nat(12), { nil: null }) }), { minLength: 1, maxLength: 12 }).map((rows) =>
      rows.map((row, i) => ({ id: `id${i}-${"abcdef".repeat(2)}`, title: row.slug ?? "", slug: row.slug, parent_id: row.parentIdx === null ? null : `id${row.parentIdx % rows.length}-${"abcdef".repeat(2)}` })));
    fc.assert(fc.property(placements, (nodes) => {
      const paths = vaultPaths(nodes);
      expect(paths.size).toBe(nodes.length);
      const lower = new Set<string>();
      for (const path of paths.values()) {
        for (const segment of path.split("/")) {
          expect(segment).not.toBe("");
          expect(segment).not.toBe("..");
          expect(segment.startsWith(".")).toBe(false);
          expect(segment).not.toMatch(/[\\]/);
        }
        expect(lower.has(path.toLowerCase())).toBe(false);
        lower.add(path.toLowerCase());
      }
    }), fuzzParams(600));
  });

  it("image links: only uploaded files are linked, hostile bodies and note paths never throw, time stays linear", () => {
    const urls = new Map<string, string | null>([["a.png", "/api/media/a.png"], ["dir/b.pdf", "/api/media/b.pdf"], ["x/c.mp3", null], ["dir/a.png", "/api/media/da.png"]]);
    const uploaded = new Set(["/api/media/a.png", "/api/media/b.pdf", "/api/media/da.png"]);
    const notePath = fc.oneof(fc.constantFrom("note.md", "dir/note.md", "a/b/c/d.md", "../x.md", "/abs.md", "dir\\n.md"), anyString);
    fc.assert(fc.property(noteText, notePath, (body, path) => {
      expectWithinBudget("importedImageLinks", body, 300, () => {
        const out = importedImageLinks(urls).rewrite(body, path);
        // Every /api/media/ address in the output is one of the uploads, or was already in the text.
        for (const m of out.matchAll(/\/api\/media\/[^\s)\]"]*/g)) {
          const url = m[0].replace(/[?#].*$/, "");
          expect(uploaded.has(url) || body.includes(m[0]), url).toBe(true);
        }
      });
    }), fuzzParams(500));
  });

  it("frontmatter split for import never throws and keeps the body bytes", () => {
    fc.assert(fc.property(noteText, (content) => {
      const note = importedNoteContent(content);
      expect(Array.isArray(note.tags)).toBe(true);
      expect(typeof note.markdown).toBe("string");
      if (!/^---/.test(content)) expect(note.markdown).toBe(content);
    }), fuzzParams(500));
  });

  it("request schema: never throws on any JSON; refused paths carry an issue, not a pass", () => {
    const file = fc.oneof(
      fc.record({ path: anyString, content: anyString }),
      fc.record({ path: anyString, base64: anyString }),
      fc.record({ path: anyString, content: anyString, kind: fc.constantFrom("drawing", "markdown", "x") }),
      fc.anything(),
    );
    const body = fc.oneof(fc.record({ files: fc.array(file, { maxLength: 4 }) }), fc.anything(), fc.record({ files: fc.array(file, { maxLength: 3 }), upsert: fc.anything(), source: fc.anything() }));
    fc.assert(fc.property(body, (input) => {
      const result = obsidianImportSchema.safeParse(input);
      if (!result.success) { expect(result.error.issues.length).toBeGreaterThan(0); return; }
      // Accepted: every path is one importPath accepts and is unique.
      const seen = new Set<string>();
      for (const f of result.data.files) {
        const p = importPath(f.path);
        expect(p).not.toBeNull();
        expect(seen.has(p!)).toBe(false);
        seen.add(p!);
      }
    }), fuzzParams(1000));
  });

  // PostgreSQL text cannot hold a NUL, and a lone surrogate is not valid UTF-8 (the driver would write
  // U+FFFD in its place, silently altering the note).
  it("NUL and lone surrogates in a file's content or title are refused for that file, not stored", () => {
    // The request validates (one bad file does not fail the batch); importMarkdownNote then skips that file
    // as `invalid_text`, through noteSizeProblem on the body and the title (frontmatter, file name, drawing title).
    for (const content of ["a\u0000b", "a\ud800b", "---\ntitle: a\u0000b\n---\nbody", "---\ntitle: a\udc00b\n---\nbody"]) {
      expect(obsidianImportSchema.safeParse({ files: [{ path: "a.md", content }] }).success, JSON.stringify(content)).toBe(true);
      const { title, markdown } = importedNoteContent(content);
      expect(["contains_nul", "invalid_text"], JSON.stringify(content)).toContain(noteSizeProblem({ markdown, title: title ?? "x" }));
    }
    expect(noteSizeProblem({ markdown: "fine 😀 text", title: "ok 😀" })).toBeNull();
    // A path is part of every file's identity (and its title): refused up front.
    expect(obsidianImportSchema.safeParse({ files: [{ path: "a\ud800.md", content: "x" }] }).success).toBe(false);
    expect(obsidianImportSchema.safeParse({ files: [{ path: "a\u0000.md", content: "x" }] }).success).toBe(false);
  });
});
