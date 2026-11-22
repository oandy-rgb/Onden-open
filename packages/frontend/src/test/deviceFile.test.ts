// lib/deviceFile.ts: writing the file for another device, and the words for what can go wrong with it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ apiFetch: vi.fn(), download: vi.fn() }));
vi.mock("../lib/data", () => ({ reads: { workspace: { deviceFile: calls.apiFetch } } }));
vi.mock("../lib/download", () => ({ downloadBlob: calls.download }));

import { ApiError } from "../lib/api";
import { deviceFileRefusal, holdsSummary, makeDeviceFile } from "../lib/deviceFile";
import { ensureWordingFor, isKnownServerCode } from "../lib/serverErrors";

const stream = (...lines: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`)); controller.close(); },
}));

describe("making the file", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("writes what the source sends and hands it to the browser's download when the last line is the manifest", async () => {
    calls.apiFetch.mockResolvedValue(stream('{"kind":"hello"}', '{"kind":"page","page":{}}', '{"kind":"manifest","pages":1,"digest":[]}'));
    const seen: number[] = [];
    const written = await makeDeviceFile("ticket", (bytes) => seen.push(bytes));
    expect(written).toMatchObject({ how: "download" });
    expect(seen.at(-1)).toBe((written as { bytes: number }).bytes);
    expect(calls.apiFetch).toHaveBeenCalledWith("ticket", undefined); // the ticket goes with the request
    expect(calls.download).toHaveBeenCalledTimes(1);
    const [blob, name] = calls.download.mock.calls[0] as [Blob, string];
    expect(name).toMatch(/^Onden notes \d{4}-\d{2}-\d{2}\.onden$/); // plain words, a date and an extension of its own: no technical name
    expect((await blob.text()).trimEnd().split("\n")).toHaveLength(3);
  });

  it("does not hand over a file that gave up half way (it ends with an error line, not the manifest)", async () => {
    calls.apiFetch.mockResolvedValue(stream('{"kind":"hello"}', '{"kind":"error","code":"snapshot_failed"}'));
    await expect(makeDeviceFile("ticket", () => {})).rejects.toThrow("incomplete");
    expect(calls.download).not.toHaveBeenCalled();
  });

  it("a refusal is an ApiError with the plain sentence and not the backend's English detail, and nothing is downloaded", async () => {
    calls.apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: "snapshot_foreign_origin", detail: "this database holds stamps made on another node" }), { status: 409 }));
    const failure = await makeDeviceFile("ticket", () => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).message).not.toMatch(/stamps|node/);
    expect(calls.download).not.toHaveBeenCalled();
  });

  it("tells a whole file from a cut one by the start of its last line, however the pieces fall and however long that line is", async () => {
    const pieces = (...parts: string[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }));
    // the manifest line carries a digest of every table: far longer than any fixed tail, and cut anywhere by the network
    calls.apiFetch.mockResolvedValueOnce(pieces('{"kind":"page"}\n{"pages":0,"digest":[', "1,".repeat(100_000), '2],"kind":"ma', 'nifest"}\n'));
    await expect(makeDeviceFile("ticket", () => {})).resolves.toMatchObject({ how: "download" });
    calls.apiFetch.mockResolvedValueOnce(pieces('{"kind":"page"}\n{"kind":"manifest","pages":0}')); // no newline at the very end
    await expect(makeDeviceFile("ticket", () => {})).resolves.toMatchObject({ how: "download" });
    calls.apiFetch.mockResolvedValueOnce(pieces('{"kind":"manifest","pages":0}\n{"kind":"page"}\n'));
    await expect(makeDeviceFile("ticket", () => {})).rejects.toThrow("incomplete");
    calls.apiFetch.mockResolvedValueOnce(pieces(""));
    await expect(makeDeviceFile("ticket", () => {})).rejects.toThrow("incomplete");
  });
});

describe("what would be erased", () => {
  it("is worded from the backend's counts, and says nothing when they are all zero", () => {
    expect(holdsSummary({ own_notes: 3, trash: 2, own_tags: 1, spaces: 0, files: 4, prefs: 1 })).toBe("3 notes, 2 in the trash, 1 tags, 4 pictures and files, your settings");
    expect(holdsSummary({ own_notes: 0, trash: 0, own_tags: 0, spaces: 0, files: 0, prefs: 0 })).toBeNull();
  });
});

// The list is private to lib/deviceFile.ts (loaded on use); the test reads the codes out of its source.
const DEVICE_FILE_REFUSALS = [...readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../lib/deviceFile.ts"), "utf8")
  .match(/const DEVICE_FILE_REFUSALS = \[([^\]]*)\]/)![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);

describe("the refusals of a file from another device", () => {
  it("every code has its own sentence, and none shows an id, a code or a file format", async () => {
    expect(DEVICE_FILE_REFUSALS.length).toBeGreaterThan(30);
    for (const code of DEVICE_FILE_REFUSALS) {
      await ensureWordingFor(code);
      expect(isKnownServerCode(code), code).toBe(true);
      const text = deviceFileRefusal(409, code, JSON.stringify({ error: code, detail: "an English sentence with (a kind) and 1234" })).message;
      expect(text, code).not.toMatch(/snapshot|ndjson|json|stamp|join_|_|\b\d{4}\b/i);
      expect(text.length, code).toBeGreaterThan(10);
    }
  });

  it("every code the backend's join and snapshot code can say is in the contract's list", () => {
    const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend/src");
    const files: string[] = [];
    for (const dir of ["spine", "services"]) for (const name of readdirSync(join(backend, dir))) {
      if (/^(stampedImport|stampedJoin|stampedSnapshot\w*)\.ts$/.test(name) && statSync(join(backend, dir, name)).isFile()) files.push(join(backend, dir, name));
    }
    expect(files.length).toBeGreaterThanOrEqual(4);
    const said = new Set<string>();
    for (const file of files) for (const m of readFileSync(file, "utf8").matchAll(/"((?:join|snapshot)_[a-z_]+)"/g)) said.add(m[1]!);
    said.delete("snapshot_export"); // a purpose of a fresh-proof ticket (backend services/freshProof.ts), not a code a refusal carries
    const listed = new Set<string>(DEVICE_FILE_REFUSALS);
    expect([...said].filter((code) => !listed.has(code))).toEqual([]);
  });
});
