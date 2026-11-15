import { describe, it, expect, beforeEach } from "vitest";
import { bindAccountStorage } from "../lib/accountStorage";
import { PREFS, getPref, setPref } from "../lib/prefs";
import { getNewNoteTarget, rememberedSpace, setNewNoteTarget, spaceTarget, topLevelSpace, writableSpaces } from "../lib/newNoteTarget";
import type { Space } from "../lib/spaces";

const space = (id: string, kind: Space["kind"], over: Partial<Space> = {}): Space => ({
  id, name: id, kind, is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...over,
});
const ME = space("me", "personal", { can_manage: true });
const WEB = space("web", "shared");

beforeEach(() => { localStorage.clear(); bindAccountStorage("unit-test-account", ""); });

describe("the new-note target", () => {
  it("reads the old format (a bare note id) as a note", () => {
    setPref(PREFS.quickCaptureTarget, "3f2c-note");
    expect(getNewNoteTarget()).toEqual({ kind: "note", noteId: "3f2c-note" });
  });

  it("round-trips a note, a space and none", () => {
    setNewNoteTarget({ kind: "space", spaceId: "web" });
    expect(getNewNoteTarget()).toEqual({ kind: "space", spaceId: "web" });
    setNewNoteTarget({ kind: "note", noteId: "n1" });
    expect(getPref(PREFS.quickCaptureTarget)).toBe("n1");
    setNewNoteTarget(null);
    expect(getNewNoteTarget()).toBeNull();
  });

  it("lists writable spaces, personal first, never system or view-only", () => {
    const list = [WEB, space("sys", "system"), space("ro", "shared", { permission: "view" }), ME];
    expect(writableSpaces(list).map((s) => s.id)).toEqual(["me", "web"]);
  });

  it("offers a choice only with two or more writable spaces", () => {
    expect(topLevelSpace([ME, space("ro", "shared", { permission: "view" })], null)).toBeNull();
    expect(topLevelSpace([], null)).toBeNull();
    expect(topLevelSpace([ME, WEB], null)?.id).toBe("me");
    expect(topLevelSpace([ME, WEB], { kind: "space", spaceId: "web" })?.id).toBe("web");
  });

  it("a remembered space that is gone reads as the personal space", () => {
    expect(rememberedSpace([ME, WEB], { kind: "space", spaceId: "gone" })).toBeNull();
    expect(topLevelSpace([ME, WEB], { kind: "space", spaceId: "gone" })?.id).toBe("me");
  });

  it("stores no target for the personal space", () => {
    expect(spaceTarget(ME)).toBeNull();
    expect(spaceTarget(WEB)).toEqual({ kind: "space", spaceId: "web" });
  });
});
