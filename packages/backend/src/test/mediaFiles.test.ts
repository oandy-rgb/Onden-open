// The media storage contract (services/mediaFiles.ts), run against every implementation that can run here: files on
// disk (the server) and IndexedDB (the browser app's fallback, against a fake). The OPFS one is run in a real browser
// by the smoke test (packages/frontend/e2e/browser-app/smoke.mjs); its quota handling is checked in browserMediaStorage.test.ts.
import "fake-indexeddb/auto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { diskMediaFiles, type MediaFiles } from "../services/mediaFiles.js";
import { createIndexedDbMediaFiles } from "../browser/mediaStorage.js";

const NAME = "0123456789abcdef0123456789abcdef.png";
const OTHER = "fedcba9876543210fedcba9876543210.webp";
const bytes = (...values: number[]) => Buffer.from(values);
const readAll = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());

async function* chunks(...parts: number[][]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Uint8Array.from(part);
}

const dir = mkdtempSync(join(tmpdir(), "media-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const implementations: Array<[string, () => Promise<MediaFiles>]> = [
  ["files on disk", async () => { const sub = mkdtempSync(join(dir, "d-")); return diskMediaFiles(sub); }],
  ["IndexedDB", async () => { const files = await createIndexedDbMediaFiles(); await files.clear(); return files; }],
];

describe.each(implementations)("media storage: %s", (_label, make) => {
  let files: MediaFiles;
  beforeEach(async () => { files = await make(); });

  it("keeps what was written, whole, and reports its size", async () => {
    await files.write(NAME, bytes(1, 2, 3, 4, 5));
    expect(await files.read(NAME)).toEqual(bytes(1, 2, 3, 4, 5));
    expect((await files.info(NAME))?.size).toBe(5);
  });

  it("a missing file is null and removing it is not an error", async () => {
    expect(await files.read(NAME)).toBeNull();
    expect(await files.info(NAME)).toBeNull();
    await files.remove(NAME);
  });

  it("writes a stream of chunks as one file and replaces a file of the same name", async () => {
    await files.write(NAME, chunks([1, 2], [3], [4, 5]));
    expect(await files.read(NAME)).toEqual(bytes(1, 2, 3, 4, 5));
    await files.write(NAME, bytes(9));
    expect(await files.read(NAME)).toEqual(bytes(9));
  });

  it("opens the whole file or an inclusive byte range as a stream", async () => {
    await files.write(NAME, bytes(10, 11, 12, 13, 14));
    expect(await readAll(files.open(NAME))).toEqual(bytes(10, 11, 12, 13, 14));
    expect(await readAll(files.open(NAME, { start: 1, end: 3 }))).toEqual(bytes(11, 12, 13));
    expect(await readAll(files.open(NAME, { start: 4, end: 4 }))).toEqual(bytes(14));
  });

  it("a source that fails part-way leaves no file, not even a short one", async () => {
    async function* failing(): AsyncGenerator<Uint8Array> { yield Uint8Array.from([1, 2]); throw new Error("the upload broke"); }
    await expect(files.write(NAME, failing())).rejects.toThrow("the upload broke");
    expect(await files.info(NAME)).toBeNull();
    expect(await files.names()).toEqual([]);
  });

  it("lists names, counts files and bytes, removes one, and forgets everything on clear", async () => {
    await files.write(NAME, bytes(1, 2, 3));
    await files.write(OTHER, bytes(4, 5));
    expect((await files.names()).sort()).toEqual([NAME, OTHER].sort());
    expect(await files.usage()).toEqual({ files: 2, bytes: 5 });
    await files.remove(NAME);
    expect(await files.names()).toEqual([OTHER]);
    await files.clear();
    expect(await files.names()).toEqual([]);
    expect(await files.usage()).toEqual({ files: 0, bytes: 0 });
  });
});

describe("files on disk", () => {
  it("never shows a temporary file as a media file, and a sweep removes the ones a crash left", async () => {
    const sub = mkdtempSync(join(dir, "s-"));
    const files = diskMediaFiles(sub);
    await files.write(NAME, bytes(1));
    writeFileSync(join(sub, ".store-left-over.tmp"), "half");
    expect(await files.names()).toEqual([NAME]);
    await files.sweepIncomplete();
    expect(readdirSync(sub)).toEqual([NAME]);
  });

  it("leaves no temporary file behind when a write fails", async () => {
    const sub = mkdtempSync(join(dir, "f-"));
    async function* failing(): AsyncGenerator<Uint8Array> { yield Uint8Array.from([1]); throw new Error("x"); }
    await expect(diskMediaFiles(sub).write(NAME, failing())).rejects.toThrow("x");
    expect(readdirSync(sub)).toEqual([]);
  });
});
