// D65: the upload size caps were stated three ways and the proxy won. The
// media table allowed a 200 MB mp3, nginx refused anything over 20 MB with an
// HTML 413 page, so the backend's "file exceeds N MB" never ran and the user
// read HTML. Now @onden/markdown mediaTypes.ts owns both transport caps,
// nginx.conf states the same numbers (checked here), and uploadMedia refuses
// an oversized file before sending it and turns any 413 into one message.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BACKUP_REQUEST_BYTES, MAX_MEDIA_REQUEST_BYTES, MAX_REQUEST_BYTES, MEDIA_TYPES } from "@onden/markdown";
import { uploadMedia } from "../lib/data/media";
import { WriteActionError } from "../lib/data/writeErrors";
import { setLocalePref } from "../lib/i18n";

const MB = 1024 * 1024;
const nginx = readFileSync(join(__dirname, "../../../../docker/nginx/nginx.conf"), "utf8");

/** The client_max_body_size inside `location <match> {`, in bytes. */
function bodyCap(match: string): number {
  const start = nginx.indexOf(`location ${match} {`);
  expect(start, `location ${match}`).toBeGreaterThan(-1);
  const block = nginx.slice(start, nginx.indexOf("}", start));
  const size = /client_max_body_size\s+(\d+)([km]?);/.exec(block);
  expect(size, `client_max_body_size in location ${match}`).not.toBeNull();
  return Number(size![1]) * ({ "": 1, k: 1024, m: MB } as Record<string, number>)[size![2]];
}

function fileOf(name: string, bytes: number): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

afterEach(() => { vi.unstubAllGlobals(); setLocalePref("en"); });

describe("upload size caps — one owner (D65)", () => {
  it("nginx states the constants: /api/ is MAX_REQUEST_BYTES, the upload MAX_MEDIA_REQUEST_BYTES", () => {
    expect(bodyCap("/api/")).toBe(MAX_REQUEST_BYTES);
    expect(bodyCap("= /api/media")).toBe(MAX_MEDIA_REQUEST_BYTES);
    expect(bodyCap("= /api/backup/restore/upload")).toBe(DEFAULT_MAX_BACKUP_REQUEST_BYTES);
    expect(Math.max(...Object.values(MEDIA_TYPES).map((type) => type.maxBytes))).toBeLessThan(MAX_MEDIA_REQUEST_BYTES);
  });

  it("the backup restore upload is passed through, not buffered to an nginx temp file first", () => {
    const start = nginx.indexOf("location = /api/backup/restore/upload {");
    const block = nginx.slice(start, nginx.indexOf("}", start));
    expect(block).toMatch(/proxy_request_buffering\s+off;/);
    expect(block).toMatch(/proxy_http_version\s+1\.1;/);
  });

  it("refuses a file over its type's cap before sending it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMedia(fileOf("talk.mp3", MEDIA_TYPES[".mp3"].maxBytes + 1)))
      .rejects.toThrow(new WriteActionError("The file is larger than the 200 MB upload limit."));
    await expect(uploadMedia(fileOf("blob", 3 * MB), "logo.svg"))
      .rejects.toThrow("The file is larger than the 2 MB upload limit.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a file at its cap", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ url: "/api/media/a.mp3" })));
    vi.stubGlobal("fetch", fetch);
    expect(await uploadMedia(fileOf("talk.mp3", MEDIA_TYPES[".mp3"].maxBytes))).toBe("/api/media/a.mp3");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("turns nginx's HTML 413 into the cap message, never the HTML", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", { status: 413 })));
    setLocalePref("zh-TW");
    const error = await uploadMedia(fileOf("paper.pdf", 25 * MB)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteActionError);
    expect((error as Error).message).toBe("檔案超過 200 MB 的上傳上限。");
  });

  it("uses the server's max_bytes from its file_too_large refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "file_too_large", detail: "file exceeds 2 MB limit", max_bytes: 2 * MB,
    }), { status: 413 })));
    await expect(uploadMedia(new Blob(["<svg/>"]), "logo.svg"))
      .rejects.toThrow("The file is larger than the 2 MB upload limit.");
  });
});
