// The browser app's temporary session (`?temp=1`, docs/architecture/browser-app.md §17), worker side: files only in memory
// and refused past a limit, no look at the browser's storage at all, a page that follows every change when no copy is kept.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEMP_SESSION_MEDIA_LIMIT_BYTES } from "@onden/markdown";
import { MediaStorageFull } from "../services/mediaFiles.js";
import { memoryMediaFiles } from "../browser/mediaStorage.js";
import { openSnapshotStore } from "../browser/snapshotStore.js";
import { createSerialQueue } from "../browser/queue.js";
import { createSaveLoop } from "../browser/saveLoop.js";

const NAME = "0123456789abcdef0123456789abcdef.pdf";
const OTHER = "fedcba9876543210fedcba9876543210.pdf";
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const read = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

afterEach(() => { vi.unstubAllGlobals(); });

describe("a temporary session keeps files in memory, up to a limit", () => {
  it("stores, reads, ranges, lists and forgets a file", async () => {
    const files = memoryMediaFiles(1024);
    await files.write(NAME, Buffer.from([1, 2, 3, 4, 5]));
    expect(await files.read(NAME)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(await files.info(NAME)).toEqual(expect.objectContaining({ size: 5 }));
    expect(await read(files.open(NAME, { start: 1, end: 3 }))).toEqual(new Uint8Array([2, 3, 4]));
    expect(await files.names()).toEqual([NAME]);
    expect(await files.usage()).toEqual({ files: 1, bytes: 5 });
    await files.remove(NAME);
    expect(await files.read(NAME)).toBeNull();
    expect(await files.info(NAME)).toBeNull();
    await files.write(OTHER, bytes(3));
    await files.clear();
    expect(await files.usage()).toEqual({ files: 0, bytes: 0 });
  });

  it("refuses a file that would pass the limit, whole, with the temporary session's own code; what is there stays", async () => {
    const files = memoryMediaFiles(100);
    await files.write(NAME, bytes(60));
    const refused = await files.write(OTHER, bytes(41)).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(MediaStorageFull);
    expect(refused).toMatchObject({ status: 507, code: "temporary_session_full" });
    expect(await files.read(OTHER)).toBeNull();
    expect(await files.usage()).toEqual({ files: 1, bytes: 60 });
    await expect(files.assertRoom(41)).rejects.toMatchObject({ code: "temporary_session_full" });
    await expect(files.assertRoom(40)).resolves.toBeUndefined();
    // The same name again replaces its own bytes: it does not count twice.
    await files.write(NAME, bytes(100));
    expect(await files.usage()).toEqual({ files: 1, bytes: 100 });
    // A file arriving in pieces is refused as soon as the pieces pass the limit.
    async function* pieces() { yield bytes(60); yield bytes(60); }
    await expect(files.write(OTHER, pieces())).rejects.toBeInstanceOf(MediaStorageFull);
  });

  it("the limit is 200 MB", () => { expect(TEMP_SESSION_MEDIA_LIMIT_BYTES).toBe(200 * 1024 * 1024); });
});

describe("a temporary session never looks at the browser's storage", () => {
  it("the 'none' store reads nothing, refuses to write, and touches neither OPFS nor IndexedDB", async () => {
    const touched: string[] = [];
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => { touched.push("opfs"); throw new Error("must not be opened"); } } });
    vi.stubGlobal("indexedDB", { open: () => { touched.push("indexeddb"); throw new Error("must not be opened"); } });
    const store = await openSnapshotStore("none");
    expect(store.kind).toBe("none");
    expect(await store.read()).toBeUndefined();
    await expect(store.write(new Blob(["x"]), { journalSeq: 0, schema: "" })).rejects.toThrow();
    await store.clear(); // "start over" in a temporary session erases nothing of an ordinary one
    expect(touched).toEqual([]);
  });
});

describe("a session that keeps no copy tells its page about every change", () => {
  it("publishes the count of writes each time (the page compares it with its last download)", async () => {
    vi.useFakeTimers();
    try {
      let mark = 1;
      const states: number[] = [];
      const loop = createSaveLoop({
        queue: createSerialQueue(),
        store: { kind: "none", copyFormat: "gzip", read: async () => undefined, write: async () => { throw new Error("no"); }, clear: async () => {} },
        copy: async () => new Blob(["x"]),
        writeMark: async () => String(mark),
        report: (state) => states.push(state.changes),
        meta: () => ({ journalSeq: 0, schema: "" }),
      });
      await loop.afterJob(); // learns the starting mark
      for (let i = 0; i < 3; i++) { mark++; await loop.afterJob(); }
      expect(states).toEqual([1, 2, 3]);
      expect(loop.state()).toMatchObject({ changes: 3, unsaved: true, lastSavedAt: null });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(loop.state().lastSavedAt).toBeNull(); // nothing was ever written
    } finally { vi.useRealTimers(); }
  });
});
