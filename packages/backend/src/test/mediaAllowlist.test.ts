// Unit tests for the /api/media upload allowlist + per-type size caps (pure —
// no DB, no HTTP). Guards the regression where the allowlist only covered
// images + PDF + SVG, which 400'd lecture audio/video (teacher /
// language-learner personas) and office documents (.docx/.eml/.xlsx — lawyer
// persona). See services/mediaStore.ts.

import { describe, it, expect } from "vitest";
import { MEDIA_TYPES, acceptFor, classifyMedia } from "@onden/markdown";
import { MIME, capFor } from "../services/mediaStore.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isImportedMediaPath } from "../modules/importers/shared/images.js";

describe("media allowlist (MIME map)", () => {
  it("still accepts the original image / PDF / SVG set", () => {
    expect(MIME[".png"]).toBe("image/png");
    expect(MIME[".jpg"]).toBe("image/jpeg");
    expect(MIME[".webp"]).toBe("image/webp");
    expect(MIME[".svg"]).toBe("image/svg+xml");
    expect(MIME[".pdf"]).toBe("application/pdf");
  });

  it("accepts audio so pronunciation / lecture clips upload", () => {
    expect(MIME[".mp3"]).toBe("audio/mpeg");
    expect(MIME[".m4a"]).toBe("audio/mp4");
    expect(MIME[".wav"]).toBe("audio/wav");
    expect(MIME[".ogg"]).toBe("audio/ogg");
  });

  it("accepts video so lecture recordings upload", () => {
    expect(MIME[".mp4"]).toBe("video/mp4");
    expect(MIME[".webm"]).toBe("video/webm");
    expect(MIME[".mov"]).toBe("video/quicktime");
  });

  it("accepts office documents + .eml so casework attaches", () => {
    expect(MIME[".docx"]).toMatch(/wordprocessingml/);
    expect(MIME[".xlsx"]).toMatch(/spreadsheetml/);
    expect(MIME[".pptx"]).toMatch(/presentationml/);
    expect(MIME[".eml"]).toBe("message/rfc822");
  });

  it("rejects (omits) extensions outside the allowlist", () => {
    // The POST handler rejects when MIME[ext] is undefined.
    expect(MIME[".exe"]).toBeUndefined();
    expect(MIME[".sh"]).toBeUndefined();
    expect(MIME[".zip"]).toBeUndefined();
  });
});

describe("imported media extensions", () => {
  it("are the media table, all on the upload allowlist (storeMedia never refuses an import as unsupported)", () => {
    const imported = Object.keys(MEDIA_TYPES).filter((ext) => isImportedMediaPath(`a/file${ext.toUpperCase()}`));
    expect(imported).toEqual(Object.keys(MEDIA_TYPES));
    expect(imported.filter((ext) => !MIME[ext])).toEqual([]);
    expect(["a.md", "a.csv", "a.exe", "a"].filter(isImportedMediaPath)).toEqual([]);
  });

  it("are all allowed by the import index (imported_media_extension_check in schema.sql)", () => {
    const schema = readFileSync(fileURLToPath(new URL("../../db/schema.sql", import.meta.url)), "utf8");
    const check = schema.split("\n").find((line) => line.includes("CONSTRAINT imported_media_extension_check"))!;
    const allowed = [...check.matchAll(/'(\.[a-z0-9]+)'::text/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual(Object.keys(MEDIA_TYPES).sort());
  });
});

describe("media size caps (capFor)", () => {
  it("keeps the strict SVG cap (text payload, XSS surface)", () => {
    expect(capFor(".svg")).toBe(2 * 1024 * 1024);
  });

  it("keeps the large PDF cap", () => {
    expect(capFor(".pdf")).toBe(200 * 1024 * 1024);
  });

  it("gives video the highest cap (lecture clip)", () => {
    expect(capFor(".mp4")).toBe(500 * 1024 * 1024);
    expect(capFor(".webm")).toBe(500 * 1024 * 1024);
  });

  it("gives audio a generous cap (full recording)", () => {
    expect(capFor(".mp3")).toBe(200 * 1024 * 1024);
    expect(capFor(".m4a")).toBe(200 * 1024 * 1024);
  });

  it("caps documents at 50MB", () => {
    expect(capFor(".docx")).toBe(50 * 1024 * 1024);
    expect(capFor(".eml")).toBe(50 * 1024 * 1024);
  });

  it("falls back to the image cap for image extensions", () => {
    expect(capFor(".png")).toBe(50 * 1024 * 1024);
    expect(capFor(".jpg")).toBe(50 * 1024 * 1024);
  });
});

// D35: the allowlist, the caps, the renderers' players and the app's file
// pickers read one table (@onden/markdown mediaTypes.ts). Before it there were
// four copies and they disagreed.
describe("one media table", () => {
  it("serves every extension with the table's MIME and cap", () => {
    for (const [ext, type] of Object.entries(MEDIA_TYPES)) {
      expect(MIME[ext], ext).toBe(type.mime);
      expect(capFor(ext), ext).toBe(type.maxBytes);
    }
    expect(Object.keys(MIME).sort()).toEqual(Object.keys(MEDIA_TYPES).sort());
  });

  it("uploads every audio/video file a renderer plays as a player", () => {
    for (const ext of [".aac", ".flac", ".oga", ".ogv", ".mp3", ".mp4"]) {
      expect(MIME[ext], ext).toBeDefined();
      expect(classifyMedia(`/api/media/x${ext}`), ext).toMatch(/^(audio|video)$/);
    }
    expect(MIME[".ogv"]).toBe("video/ogg");
    expect(MIME[".aac"]).toBe("audio/aac");
    expect(MIME[".flac"]).toBe("audio/flac");
  });

  it("uploads the .ico the favicon picker offers, under the small-image cap", () => {
    expect(MIME[".ico"]).toBe("image/x-icon");
    expect(capFor(".ico")).toBe(2 * 1024 * 1024);
    expect(acceptFor("image").split(",")).toContain(".ico");
  });

  it("caps an extension off the allowlist at zero", () => {
    expect(capFor(".exe")).toBe(0);
    expect(capFor("constructor")).toBe(0);
  });
});
