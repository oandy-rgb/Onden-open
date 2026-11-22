// A file taken in from another device is "brought over" only when the browser really stored the copy (browser/saveLoop.ts copyIsStored).
import { describe, expect, it } from "vitest";
import type { BridgeSaveState } from "@onden/markdown";
import { copyIsStored } from "../browser/saveLoop.js";

const state = (over: Partial<BridgeSaveState>): BridgeSaveState => ({ store: "opfs", lastSavedAt: 1, lastCopyMs: 5, lastCopyBytes: 10, unsaved: false, changes: 1, failed: false, journal: true, journalSkipped: 0, ...over });

describe("copyIsStored", () => {
  it("is true only for a copy that was written, did not fail and has nothing newer", () => {
    expect(copyIsStored(state({}))).toBe(true);
    expect(copyIsStored(state({ failed: true }))).toBe(false);
    expect(copyIsStored(state({ unsaved: true }))).toBe(false);
    expect(copyIsStored(state({ lastSavedAt: null }))).toBe(false);
  });
  it("is false with no storage at all: that store never writes and never says failed", () => {
    expect(copyIsStored(state({ store: "none", failed: false, unsaved: false }))).toBe(false);
  });
});
