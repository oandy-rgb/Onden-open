import { describe, expect, it } from "vitest";
import { MAX_MEDIA_REQUEST_BYTES, MAX_REQUEST_BYTES, MEDIA_TYPES, acceptFor, capMegabytes, extensionsOf, mediaExtension, mediaTypeOf } from "./mediaTypes.js";
import { classifyMedia } from "./mediaEmbed.js";

describe("media table", () => {
  it("reads the extension of a name, path or URL without its query or fragment", () => {
    expect(mediaExtension("Lecture.MP3")).toBe(".mp3");
    expect(mediaExtension("/api/media/0123.webm?v=2#t=10")).toBe(".webm");
    expect(mediaExtension("https://cdn.example/dir.v2/file")).toBe("");
    expect(mediaExtension(".hidden")).toBe("");
    expect(mediaExtension("")).toBe("");
  });

  it("looks a file up by extension only, never through the prototype", () => {
    expect(mediaTypeOf("a.ico")).toEqual({ mime: "image/x-icon", kind: "image", maxBytes: 2 * 1024 * 1024 });
    expect(mediaTypeOf("a.pdf")?.kind).toBe("pdf");
    expect(mediaTypeOf("a.exe")).toBeNull();
    expect(mediaTypeOf("x.constructor")).toBeNull();
    expect(mediaTypeOf(null)).toBeNull();
  });

  it("keys lower-case dotted extensions with a positive cap", () => {
    for (const [ext, type] of Object.entries(MEDIA_TYPES)) {
      expect(ext).toMatch(/^\.[a-z0-9]+$/);
      expect(type.maxBytes).toBeGreaterThan(0);
    }
  });

  // D65: a file at its type's cap must fit through the media upload's
  // transport cap with its multipart envelope, or the proxy refuses it first.
  it("lets every file at its cap through the media upload request cap", () => {
    for (const type of Object.values(MEDIA_TYPES)) {
      expect(type.maxBytes + 64 * 1024).toBeLessThanOrEqual(MAX_MEDIA_REQUEST_BYTES);
    }
    expect(MAX_REQUEST_BYTES).toBeLessThan(MAX_MEDIA_REQUEST_BYTES);
    expect(capMegabytes(MEDIA_TYPES[".mp4"].maxBytes)).toBe(500);
    expect(capMegabytes(MAX_REQUEST_BYTES)).toBe(20);
  });

  // D35 bugs: .oga was uploadable but drawn as a broken image; .aac/.flac/.ogv
  // played but could not be uploaded; the favicon picker offered .ico.
  it("draws every uploadable audio/video file as a player", () => {
    for (const ext of [...extensionsOf("audio"), ...extensionsOf("video")]) {
      expect(classifyMedia(`/api/media/0123${ext}`), ext).toBe(MEDIA_TYPES[ext].kind);
    }
    expect(classifyMedia("/api/media/0123.oga")).toBe("audio");
    expect(classifyMedia("/api/media/0123.ogv")).toBe("video");
    expect(classifyMedia("https://cdn.example/a.FLAC?dl=1")).toBe("audio");
    expect(classifyMedia("/api/media/0123.png")).toBeNull();
  });

  it("builds a picker accept list of the table's concrete MIME types, then its extensions", () => {
    const image = acceptFor("image").split(",");
    expect(image.slice(0, 7)).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon"]);
    expect(image.slice(7)).toEqual(extensionsOf("image"));
    expect(acceptFor("audio").split(",")).toEqual(expect.arrayContaining(["audio/mpeg", "audio/ogg", "audio/aac", "audio/flac", ".aac", ".flac", ".oga"]));
    expect(acceptFor("pdf")).toBe("application/pdf,.pdf");
    // MIME parameters dropped; duplicates (audio/ogg for .oga and .ogg) once.
    expect(acceptFor("document")).toContain("text/plain,");
    expect(acceptFor("document")).not.toContain(";");
    const all = acceptFor("image", "audio", "video", "pdf", "document").split(",");
    expect(new Set(all).size).toBe(all.length);
    // Never a wildcard: only what the server takes.
    expect(all.some((entry) => entry.endsWith("/*"))).toBe(false);
  });
});
