import { describe, it, expect, vi, afterEach } from "vitest";
import { MEDIA_TYPES } from "@onden/markdown";
import { INSERT_MEDIA_ACCEPT } from "../lib/mediaInsert";
import { uploadMedia } from "../lib/data";

describe("insert-file media types", () => {
  it("offer image, audio and video extensions the server takes, and nothing else", () => {
    const accept = INSERT_MEDIA_ACCEPT.split(",");
    for (const ext of [".png", ".mp3", ".m4a", ".mp4", ".webm", ".mov", "audio/mpeg", "video/mp4"]) expect(accept).toContain(ext);
    for (const ext of [".pdf", ".docx", ".txt", "application/pdf"]) expect(accept).not.toContain(ext);
    for (const item of accept.filter((a) => a.startsWith("."))) expect(MEDIA_TYPES[item]).toBeDefined();
    expect(INSERT_MEDIA_ACCEPT).not.toMatch(/\/\*/);
  });
});

describe("uploadMedia refusals in plain words", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an unsupported type before sending anything", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(uploadMedia(new File(["x"], "setup.exe"))).rejects.toThrow("This file type can't be uploaded.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an oversized file with its limit before sending anything", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const big = new File(["x"], "photo.png");
    Object.defineProperty(big, "size", { value: 51 * 1024 * 1024 });
    await expect(uploadMedia(big)).rejects.toThrow("50 MB");
    expect(fetch).not.toHaveBeenCalled();
  });
});
