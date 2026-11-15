// Excalidraw drawings in a folder import (frontend settings/drawingImport.ts
// converts them; the request carries kind "drawing"): the note is a
// handwriting note — its page in ink_data, its title the file name, its text
// as the body. It is converted at import only: the original drawing is not
// kept, even when an older client still sends it as drawing_source.
// Re-importing the same source turns an earlier Markdown copy of the drawing
// into the handwriting note in place, never a duplicate; strokes added since
// the import are never overwritten.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const SOURCE = { id: "legacy", name: "Older imports" };
type ImportFile = { path: string; content: string; kind?: "drawing"; title?: string; ink_data?: string; drawing_source?: string };
async function importFiles(files: ImportFile[]) {
  const res = await app.request("/api/import/obsidian", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ source: SOURCE, files, upsert: true }),
  });
  expect(res.status).toBe(200);
  return await res.json() as { imported: number; updated: number; unchanged: number; skipped: number; conflicts: Array<{ path: string; reason: string }> };
}

// Per test (beforeEach): its own folder, so no test starts from the drawing
// another one imported or drew on.
let STAMP = "";
let PATH = "";
const page = (n: number) => JSON.stringify({ version: 1, strokes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, points: [[24, 24, 0.5], [40, 30, 0.6]], color: "#1e1e1e", size: 6.25, toolId: "pen" })), erased: {}, page: { width: 1000 } });
const SOURCE_BLOCK = "```compressed-json\nN4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JRJQgEYA6bGwC2CgF7N6hbEcK4OCtptbErHALRY8RMpWdx8Q1TdIEfARcZgRmBShcZQUe\n```";
const drawing = (ink: string, body = "A caption.\n"): ImportFile => ({
  path: PATH, content: body, kind: "drawing", title: "2024-12-30 11.51.22", ink_data: ink, drawing_source: SOURCE_BLOCK,
});

describe.skipIf(!isTestDb)("excalidraw drawings import as handwriting notes", () => {
  let WS = "";
  const notesAt = (path: string) => q<{ id: string; title: string; markdown: string }>(
    `SELECT n.id, n.title, n.markdown FROM content_nodes n
       JOIN node_attributes a ON a.node_id = n.id AND a.key = '_import_path' AND a.value = $2
      WHERE n.workspace_id = $1 AND n.deleted_at IS NULL`, [WS, path]);
  const attr = async (nodeId: string, key: string) =>
    (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0]?.value ?? null;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });
  beforeEach(() => {
    STAMP = `exc${randomUUID().slice(0, 8)}`;
    PATH = `${STAMP}/畫畫/2024-12-30 11.51.22.excalidraw.md`;
  });

  it("an earlier Markdown copy becomes the handwriting note in place, then re-imports as unchanged", async () => {
    // What older imports made of the drawing: a note full of compressed text.
    const raw = `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n%%\n## Drawing\n${SOURCE_BLOCK}\n%%`;
    expect((await importFiles([{ path: PATH, content: raw }])).imported).toBe(1);
    const [old] = (await notesAt(PATH)).rows;
    expect(old.title).toBe("2024-12-30 11.51.22.excalidraw");

    const result = await importFiles([drawing(page(3))]);
    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    const rows = (await notesAt(PATH)).rows;
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0].id).toBe(old.id); // the same note
    expect(rows[0].title).toBe("2024-12-30 11.51.22");
    expect(rows[0].markdown).toBe("A caption.\n");
    expect(JSON.parse((await attr(old.id, "ink_data"))!).strokes).toHaveLength(3);
    expect(await attr(old.id, "_import_excalidraw")).toBeNull();

    expect(await importFiles([drawing(page(3))])).toMatchObject({ unchanged: 1, updated: 0, imported: 0 });
  });

  it("a changed drawing updates the page; strokes added in Onden since are never overwritten", async () => {
    expect(await importFiles([drawing(page(3))])).toMatchObject({ imported: 1 });
    const [note] = (await notesAt(PATH)).rows;
    expect(await importFiles([drawing(page(4))])).toMatchObject({ updated: 1 });
    expect(JSON.parse((await attr(note.id, "ink_data"))!).strokes).toHaveLength(4);

    // The person draws on the imported note.
    await seedQ(`UPDATE node_attributes SET value = $2, source = 'ui' WHERE node_id = $1 AND key = 'ink_data'`, [note.id, page(9)]);
    const refused = await importFiles([drawing(page(5))]);
    expect(refused).toMatchObject({ updated: 0, skipped: 1 });
    expect(refused.conflicts).toEqual([{ path: PATH, reason: "local_changes" }]);
    expect(JSON.parse((await attr(note.id, "ink_data"))!).strokes).toHaveLength(9);
  });

  it("a new drawing imports as a handwriting note with its title, without the original", async () => {
    const path = `${STAMP}/圖片/未命名 2024-10-21 15.41.23.excalidraw.md`;
    const result = await importFiles([{ ...drawing(page(2), ""), path, title: "未命名 2024-10-21 15.41.23" }]);
    expect(result.imported).toBe(1);
    const [note] = (await notesAt(path)).rows;
    expect(note.title).toBe("未命名 2024-10-21 15.41.23");
    expect(note.markdown).toBe("");
    expect(JSON.parse((await attr(note.id, "ink_data"))!).strokes).toHaveLength(2);
    expect(await attr(note.id, "_import_excalidraw")).toBeNull();
  });

  it("links written as [[name.excalidraw]] resolve to the drawing (the old name is an alias)", async () => {
    const dir = `${STAMP}/links`;
    const drawingPath = `${dir}/2025-12-02 11.05.08.excalidraw.md`;
    const linkerPath = `${dir}/Notes.md`;
    // As Obsidian writes them: an embed and a plain link to the drawing file's name.
    const linker = { path: linkerPath, content: "See ![[2025-12-02 11.05.08.excalidraw]] and [[2025-12-02 11.05.08.excalidraw|the sketch]].\n" };
    // Before: the drawing imported as Markdown (titled "….excalidraw"), linked by title.
    const raw = `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n%%\n${SOURCE_BLOCK}\n%%`;
    await importFiles([{ path: drawingPath, content: raw }, linker]);
    const linkerId = (await notesAt(linkerPath)).rows[0].id;
    const drawingId = (await notesAt(drawingPath)).rows[0].id;
    const linksTo = async () => (await q<{ target_node_id: string }>(
      `SELECT target_node_id FROM node_edges WHERE source_node_id = $1 AND target_node_id IS NOT NULL`, [linkerId])).rows.map((r) => r.target_node_id);
    await vi.waitFor(async () => expect(await linksTo()).toContain(drawingId), { timeout: 5000 });

    // After: the same source again, the drawing converted (title without
    // ".excalidraw", the old name as an alias in its frontmatter).
    const body = `---\nexcalidraw-plugin: parsed\naliases: ["2025-12-02 11.05.08.excalidraw"]\n---\n`;
    const result = await importFiles([{ ...drawing(page(2), body), path: drawingPath, title: "2025-12-02 11.05.08" }, linker]);
    expect(result).toMatchObject({ updated: 1, unchanged: 1 });
    expect((await notesAt(drawingPath)).rows[0].title).toBe("2025-12-02 11.05.08");
    // The linking note is re-saved (an edit elsewhere) — its links still find the drawing.
    await importFiles([{ ...linker, content: linker.content + "More.\n" }]);
    await vi.waitFor(async () => expect(await linksTo()).toContain(drawingId), { timeout: 5000 });

    // And a drawing imported fresh, linked from a note in the same import.
    const freshPath = `${dir}/fresh.excalidraw.md`;
    const freshLinker = { path: `${dir}/Fresh links.md`, content: "![[fresh.excalidraw]]\n" };
    await importFiles([{ ...drawing(page(1), `---\naliases: ["fresh.excalidraw"]\n---\n`), path: freshPath, title: "fresh" }, freshLinker]);
    const freshId = (await notesAt(freshPath)).rows[0].id;
    const freshLinkerId = (await notesAt(freshLinker.path)).rows[0].id;
    await vi.waitFor(async () => {
      const rows = (await q<{ target_node_id: string }>(`SELECT target_node_id FROM node_edges WHERE source_node_id = $1`, [freshLinkerId])).rows;
      expect(rows.map((r) => r.target_node_id)).toContain(freshId);
    }, { timeout: 5000 });
  });
});
