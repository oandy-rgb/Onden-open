import { describe, expect, it, vi } from "vitest";
import { compressToBase64 } from "lz-string";
import { MAX_IMPORT_REQUEST_BYTES, importedMediaKind, mergeImportResults, planImportBatches, uploadFolderImport, type FolderImportFile, type ImportResult } from "../modules/importers/folderImport";

const note = (path: string, size = 10): FolderImportFile => ({ path, content: "x".repeat(size) });
const image = (path: string, size = 10): FolderImportFile => ({ path, base64: "A".repeat(size), kind: "image" });
const source = { id: "6f1c9a52-0d38-4c86-9df3-3b1f7a0e2b11", name: "obsidian-vault" };

describe("folder import batches", () => {
  it("sends images first, keeps every batch under the target, and loses no file", () => {
    const files = [note("1.Project（專案/a.md", 400), image("圖片/1.png", 500), note("b.md", 400), image("圖片/2.png", 500), note("c.md", 400)];
    const { batches, tooLarge } = planImportBatches(files, 1000);
    expect(tooLarge).toEqual([]);
    expect(batches.map(batch => batch.map(file => file.path))).toEqual([["圖片/1.png"], ["圖片/2.png"], ["1.Project（專案/a.md", "b.md"], ["c.md"]]);
    expect(batches.flat()).toHaveLength(files.length);
  });

  it("gives an oversized file its own batch, and lists one over the request limit instead of sending it", () => {
    const { batches, tooLarge } = planImportBatches([image("big.png", 5000), image("huge.jpg", MAX_IMPORT_REQUEST_BYTES + 1), note("a.md")], 1000);
    expect(batches.map(batch => batch.map(file => file.path))).toEqual([["big.png"], ["a.md"]]);
    expect(tooLarge).toEqual([{ path: "huge.jpg", kind: "file" }]);
  });

  it("sends each CSV database with its own pages, and the rest of the text in normal batches", () => {
    const { batches, tooLarge } = planImportBatches([
      note("Tasks 1a2b.csv", 300), note("Tasks 1a2b_all.csv", 300), note("Tasks 1a2b/Write intro 3c4d.md", 300),
      note("Reading 5e6f.csv", 300), note("Reading 5e6f/Dune 7a8b.md", 300),
      // A database nested in another's folder belongs to the innermost one.
      note("Tasks 1a2b/Sub 9c9c.csv", 300), note("Tasks 1a2b/Sub 9c9c/Leaf 0d0d.md", 300),
      note("Journal.md", 600), note("Ideas.md", 600),
    ], 1000);
    expect(tooLarge).toEqual([]);
    expect(batches.map(batch => batch.map(file => file.path))).toEqual([
      ["Tasks 1a2b.csv", "Tasks 1a2b_all.csv", "Tasks 1a2b/Write intro 3c4d.md"],
      ["Reading 5e6f.csv", "Reading 5e6f/Dune 7a8b.md"],
      ["Tasks 1a2b/Sub 9c9c.csv", "Tasks 1a2b/Sub 9c9c/Leaf 0d0d.md"],
      ["Journal.md"], ["Ideas.md"],
    ]);
  });

  it("lists a database too large for one request instead of sending part of it", () => {
    const { batches, tooLarge } = planImportBatches([
      note("Huge.csv", 400), note("Huge/a.md", MAX_IMPORT_REQUEST_BYTES / 2), note("Huge/b.md", MAX_IMPORT_REQUEST_BYTES / 2), note("other.md"),
    ]);
    expect(tooLarge).toEqual([{ path: "Huge.csv", kind: "collection" }]);
    expect(batches.map(batch => batch.map(file => file.path))).toEqual([["other.md"]]);
  });

  it("composes the batches with one source, passes image URLs on, and adds up the result", async () => {
    const responses: ImportResult[] = [
      { imported: 0, skipped: 0, folders: 0, images_imported: 1, image_urls: { "圖片/1.png": "/api/media/1.png" } },
      { imported: 0, skipped: 0, folders: 0, images_skipped: 1, skipped_images: [{ path: "圖片/2.png", reason: "unreadable" }], image_urls: { "圖片/2.png": null } },
      { imported: 1, skipped: 1, folders: 2, conflicts: [{ path: "a.md", reason: "folder_unavailable" }], unsupported_exts: [".pdf"] },
      { imported: 1, skipped: 0, folders: 0, folders_reused: 2, unchanged: 3, unsupported_exts: [".mp3", ".pdf"] },
    ];
    const send = vi.fn(async () => responses.shift()!);
    const onProgress = vi.fn();
    const files = [image("圖片/1.png", 500), image("圖片/2.png", 500), note("a.md", 600), note("b.md", 600)];
    const { result } = await uploadFolderImport({ files, source, send, onProgress, targetBytes: 1000 });
    expect(send).toHaveBeenCalledTimes(4);
    const bodies = send.mock.calls.map(call => (call as unknown[])[0] as { source: unknown; upsert: boolean; uploaded_images?: unknown });
    expect(bodies.every(body => body.source === source && body.upsert)).toBe(true);
    expect(bodies[0]!.uploaded_images).toBeUndefined();
    expect(bodies[1]!.uploaded_images).toBeUndefined();
    expect(bodies[2]!.uploaded_images).toEqual({ "圖片/1.png": "/api/media/1.png", "圖片/2.png": null });
    expect(onProgress.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4].map(batch => ({ batch, batches: 4 })));
    expect(result).toMatchObject({ imported: 2, skipped: 1, unchanged: 3, folders: 2, folders_reused: 2, images_imported: 1, images_skipped: 1,
      conflicts: [{ path: "a.md", reason: "folder_unavailable" }], skipped_images: [{ path: "圖片/2.png", reason: "unreadable" }], unsupported_exts: [".mp3", ".pdf"] });
  });

  it("stops at a failed batch with its error, after the earlier batches", async () => {
    const send = vi.fn().mockResolvedValueOnce({ imported: 1, skipped: 0, folders: 0 }).mockRejectedValueOnce(new Error("413"));
    await expect(uploadFolderImport({ files: [note("a.md", 600), note("b.md", 600), note("c.md", 600)], source, send, targetBytes: 1000 })).rejects.toThrow("413");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends Excalidraw drawings as handwriting notes and reports what wasn't drawn", async () => {
    const scene = { type: "excalidraw", elements: [
      { id: "f", type: "freedraw", x: 0, y: 0, strokeWidth: 2, points: [[0, 0], [5, 5]], pressures: [0.3, 0.6], simulatePressure: false },
      { id: "fr", type: "frame", x: 0, y: 0 },
    ] };
    const drawing = `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n%%\n## Drawing\n\`\`\`compressed-json\n${compressToBase64(JSON.stringify(scene))}\n\`\`\`\n%%`;
    const broken = "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n%%\n## Drawing\n```compressed-json\n!!!\n```\n%%";
    const send = vi.fn().mockResolvedValue({ imported: 2, skipped: 0, folders: 1 });
    const { result } = await uploadFolderImport({
      files: [{ path: "畫畫/sketch.excalidraw.md", content: drawing }, { path: "畫畫/bad.excalidraw.md", content: broken }, note("a.md")],
      source, send,
    });
    const sent = (send.mock.calls[0] as unknown[])[0] as { files: Array<Record<string, string>> };
    const converted = sent.files.find((f) => f.path === "畫畫/sketch.excalidraw.md")!;
    // Converted at import: the plugin's frontmatter key is dropped and no original is sent.
    expect(converted).toMatchObject({ kind: "drawing", title: "sketch", content: '---\naliases: ["sketch.excalidraw"]\n---\n' });
    expect(JSON.parse(converted.ink_data).strokes).toHaveLength(1);
    expect(converted).not.toHaveProperty("drawing_source");
    // Unreadable: sent as before (Markdown), and listed.
    expect(sent.files.find((f) => f.path === "畫畫/bad.excalidraw.md")).toEqual({ path: "畫畫/bad.excalidraw.md", content: broken });
    expect(result).toMatchObject({
      drawings_converted: 1, drawings_unreadable: ["畫畫/bad.excalidraw.md"],
      drawing_skips: [{ path: "畫畫/sketch.excalidraw.md", type: "frame", count: 1, reason: expect.any(String) }],
    });
  });
});

describe("media files in a folder import (D91)", () => {
  it("sends every kind on the media table — audio, video and documents included — and nothing else", () => {
    expect(["a.PNG", "paper.pdf", "song.mp3", "clip.mp4", "slides.pptx", "note.md", "data.csv", "x.exe", "README"].map(importedMediaKind))
      .toEqual(["image", "pdf", "media", "media", "media", null, null, null, null]);
  });

  it("adds up relations across batches", () => {
    const first: ImportResult = { imported: 1, skipped: 0, folders: 0, relations_resolved: 2, relations_unresolved: 1,
      unresolved_relations: [{ path: "a.md", key: "owner", value: "[[Gone]]" }] };
    const merged = mergeImportResults(first, { imported: 1, skipped: 0, folders: 0, relations_resolved: 1, relations_unresolved: 0, unresolved_relations: [] });
    expect(merged).toMatchObject({ relations_resolved: 3, relations_unresolved: 1, unresolved_relations: [{ path: "a.md", key: "owner" }] });
  });
});
