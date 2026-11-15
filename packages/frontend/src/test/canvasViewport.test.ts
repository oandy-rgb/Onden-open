// P0-5 縮放定位: the canvas viewport persistence helper. The component fix
// (KnowledgeWorkspace: restore on onInit/effect, gate fitView behind "no
// stash", stash on unmount) is verified end-to-end by canvasUndo.spec.ts; this
// covers the pure read/write/validation that decides whether a restore happens
// at all (a malformed/absent stash MUST fall through to the auto-fit path).
import { describe, it, expect, beforeEach } from "vitest";
import { readViewport, writeViewport, isValidViewport } from "../lib/canvasViewport";

describe("canvasViewport", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  describe("isValidViewport", () => {
    it("accepts a finite x/y/zoom triple", () => {
      expect(isValidViewport({ x: 1, y: 2, zoom: 0.5 })).toBe(true);
    });
    it("rejects missing / non-finite fields and non-objects", () => {
      expect(isValidViewport(null)).toBe(false);
      expect(isValidViewport(undefined)).toBe(false);
      expect(isValidViewport("nope")).toBe(false);
      expect(isValidViewport({ x: 1, y: 2 })).toBe(false);
      expect(isValidViewport({ x: NaN, y: 0, zoom: 1 })).toBe(false);
      expect(isValidViewport({ x: 0, y: 0, zoom: Infinity })).toBe(false);
    });
  });

  it("round-trips a written viewport", () => {
    writeViewport("cv1", { x: 12, y: -34, zoom: 0.75 });
    expect(readViewport("cv1")).toEqual({ x: 12, y: -34, zoom: 0.75 });
  });

  it("scopes the stash per canvas id", () => {
    writeViewport("cv1", { x: 1, y: 1, zoom: 1 });
    writeViewport("cv2", { x: 9, y: 9, zoom: 2 });
    expect(readViewport("cv1")).toEqual({ x: 1, y: 1, zoom: 1 });
    expect(readViewport("cv2")).toEqual({ x: 9, y: 9, zoom: 2 });
  });

  it("returns null for an absent / null canvas (→ caller auto-fits)", () => {
    expect(readViewport("missing")).toBeNull();
    expect(readViewport(null)).toBeNull();
  });

  it("returns null and does not throw for a corrupt stash", () => {
    window.sessionStorage.setItem("onden.canvasViewport.bad", "{not json");
    expect(readViewport("bad")).toBeNull();
  });

  it("returns null when the stored viewport is structurally invalid", () => {
    window.sessionStorage.setItem(
      "onden.canvasViewport.partial",
      JSON.stringify({ x: 1, y: 2 }),
    );
    expect(readViewport("partial")).toBeNull();
  });

  it("ignores writes with a null canvas id or invalid viewport", () => {
    writeViewport(null, { x: 1, y: 2, zoom: 1 });
    writeViewport("cv", null);
    writeViewport("cv", { x: NaN, y: 0, zoom: 1 });
    expect(window.sessionStorage.length).toBe(0);
  });
});
