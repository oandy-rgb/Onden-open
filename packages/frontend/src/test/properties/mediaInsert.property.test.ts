// Random clipboards and drops against lib/mediaInsert.ts (what a paste or drop into the note editor takes as media).
// Invariants (scan 01 #2, #9):
//   • a clipboard with any non-blank text is a text paste: no file is taken, whatever files ride along
//   • a clipboard of only files takes every insertable one, in order, and none else
//   • a drop is split with nothing lost or doubled: media and rest together are the files, in order
//   • audio and video files are media for a drop and a paste, as they are for the file picker
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/mediaInsert

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { INSERT_MEDIA_ACCEPT, pastedMediaFiles, splitDroppedFiles } from "../../lib/mediaInsert";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const params = { numRuns: PROPS_RUNS, seed: PROPS_SEED };

const NAMES = ["a.png", "photo.JPG", "clip.mp4", "song.mp3", "note.pdf", "sheet.xlsx", "image.png", "noext", "x.webm", "中文.jpeg", "doc.txt"];
const TYPES = ["image/png", "image/jpeg", "audio/mpeg", "video/mp4", "application/pdf", "application/octet-stream", "", "image/heic"];
const file = fc.record({ name: fc.constantFrom(...NAMES), type: fc.constantFrom(...TYPES) }).map((f) => new File(["x"], f.name, { type: f.type }));
const files = fc.array(file, { maxLength: 6 });
const blank = fc.constantFrom("", " ", "\n", "\t \n");
const text = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() !== "");

describe("mediaInsert (scan 01 #2, #9)", () => {
  it("a paste that carries text is a text paste, whatever files come with it", () => {
    fc.assert(fc.property(files, text, (fs, txt) => { expect(pastedMediaFiles(fs, txt)).toEqual([]); }), params);
  });

  it("a paste of only files takes every insertable file, in order, and no other", () => {
    fc.assert(fc.property(files, blank, (fs, txt) => {
      // The drop split is the same judgement, so a paste of files agrees with it.
      expect(pastedMediaFiles(fs, txt)).toEqual(splitDroppedFiles(fs).media);
    }), params);
  });

  it("a drop splits into media and the rest without losing or repeating a file", () => {
    fc.assert(fc.property(files, (fs) => {
      const { media, rest } = splitDroppedFiles(fs);
      expect(media.length + rest.length).toBe(fs.length);
      expect(fs.filter((f) => media.includes(f))).toEqual(media);
      expect(fs.filter((f) => rest.includes(f))).toEqual(rest);
      for (const f of rest) expect(media.includes(f)).toBe(false);
    }), params);
  });

  it("an mp3 and an mp4 are media for a drop (they were refused with an English message)", () => {
    const mp3 = new File(["x"], "song.mp3", { type: "audio/mpeg" });
    const mp4 = new File(["x"], "clip.mp4", { type: "video/mp4" });
    const pdf = new File(["x"], "paper.pdf", { type: "application/pdf" });
    expect(splitDroppedFiles([mp3, mp4, pdf])).toEqual({ media: [mp3, mp4], rest: [pdf] });
  });

  it("an Excel range copy (text plus a preview picture) pastes as text; a lone screenshot as a picture; several pictures all go in", () => {
    const shot = new File(["x"], "image.png", { type: "image/png" });
    const shot2 = new File(["x"], "image.png", { type: "image/png" });
    expect(pastedMediaFiles([shot], "a\tb\n1\t2")).toEqual([]);
    expect(pastedMediaFiles([shot], "")).toEqual([shot]);
    expect(pastedMediaFiles([shot, shot2], "  ")).toEqual([shot, shot2]);
  });

  it("everything the file picker offers by extension is insertable", () => {
    for (const ext of INSERT_MEDIA_ACCEPT.split(",").filter((a) => a.startsWith("."))) {
      expect(splitDroppedFiles([new File(["x"], `f${ext}`)]).media).toHaveLength(1);
    }
  });
});
