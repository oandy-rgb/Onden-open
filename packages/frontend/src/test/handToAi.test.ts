import { beforeEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../lib/i18n";
import { chooseTarget, entryState, handFailureText, offeredActions, targetLine, usableRoles, waysOf, type HandOptions, type HandRole } from "../lib/handToAi";

const role = (over: Partial<HandRole> = {}): HandRole => ({
  actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "api", reason: null, model_name: "m",
  runtimes: [{ kind: "api", available: true }, { kind: "mcp", available: true }], ...over,
});
const options = (...roles: HandRole[]): HandOptions => ({ can_hand_off: true, roles });
const catalogue = (off: string[] = []) => ["ask", "outline", "expand", "summarize", "fix", "rewrite", "shorten", "translate", "explain"]
  .map((id) => ({ id, kind: "builtin" as const, aiUse: !off.includes(id) }));

beforeEach(() => setLocalePref("en"));

describe("the ready-made actions", () => {
  it("come in the fixed order: rewrite, shorten, expand, fix, translate, explain", () => {
    expect(offeredActions(catalogue()).map((a) => a.id)).toEqual(["rewrite", "shorten", "expand", "fix", "translate", "explain"]);
  });
  it("a skill switched off for the AI in Settings is not listed", () => {
    expect(offeredActions(catalogue(["shorten", "translate"])).map((a) => a.id)).toEqual(["rewrite", "expand", "fix", "explain"]);
  });
  it("a skill the server doesn't have is not listed, and nothing is listed before the catalogue is read", () => {
    expect(offeredActions(catalogue().filter((s) => s.id !== "rewrite")).map((a) => a.id)).not.toContain("rewrite");
    expect(offeredActions(null)).toEqual([]);
    expect(offeredActions(undefined)).toEqual([]);
  });
  it("a note skill with the same id as nothing built-in never stands in for one", () => {
    expect(offeredActions([{ id: "rewrite", kind: "note", aiUse: true }])).toEqual([]);
  });
});

describe("which role and which way of running", () => {
  it("the role's own default way, unless the person picked another for this once", () => {
    const opts = options(role());
    expect(chooseTarget(opts)).toMatchObject({ runtime: "api" });
    expect(chooseTarget(opts, { runtime: "mcp" })).toMatchObject({ runtime: "mcp" });
    expect(targetLine(chooseTarget(opts)!)).toBe("小助手 · API key");
  });
  it("a picked way that isn't available falls back to the default; a way that can't run is never listed", () => {
    const down = role({ runtimes: [{ kind: "api", available: true }, { kind: "mcp", available: false }] });
    expect(chooseTarget(options(down), { runtime: "mcp" })).toMatchObject({ runtime: "api" });
    expect(waysOf(down)).toEqual(["api"]);
  });
  it("a default way that is unavailable falls to the first one that works", () => {
    const only = role({ default_runtime: "api", runtimes: [{ kind: "api", available: false }, { kind: "mcp", available: true }] });
    expect(chooseTarget(options(only))).toMatchObject({ runtime: "mcp" });
  });
  it("roles that can't take it now are skipped; with none usable there is no target", () => {
    const off = role({ actor_id: "off", reason: "disabled" });
    const good = role({ actor_id: "good", name: "第二個" });
    expect(usableRoles(options(off, good)).map((r) => r.actor_id)).toEqual(["good"]);
    expect(chooseTarget(options(off, good), { roleId: "off" })!.role.actor_id).toBe("good");
    expect(chooseTarget(options(off))).toBeNull();
    expect(chooseTarget(null)).toBeNull();
  });
});

describe("whether the entry is offered", () => {
  it("is not shown at all on a note that can't be edited", () => {
    expect(entryState({ canEdit: false, online: true, options: options(role()) })).toEqual({ shown: false, blocked: null });
  });
  it("offline it is shown but stopped, with the reason", () => {
    const state = entryState({ canEdit: true, online: false, options: null });
    expect(state.shown).toBe(true);
    expect(state.blocked).toMatch(/connection/);
  });
  it("is stopped when the server says this person can't edit, and when no AI can take it", () => {
    expect(entryState({ canEdit: true, online: true, options: { can_hand_off: false, roles: [] } }).blocked).toMatch(/can't edit/);
    expect(entryState({ canEdit: true, online: true, options: options() }).blocked).toMatch(/No AI is set up/);
    expect(entryState({ canEdit: true, online: true, options: options(role({ reason: "disabled" })) }).blocked).toMatch(/switched off/);
  });
  it("is open when a role can take it", () => {
    expect(entryState({ canEdit: true, online: true, options: options(role()) })).toEqual({ shown: true, blocked: null });
  });
});

describe("what the person reads when it did not work", () => {
  it("is a plain sentence, never the code", () => {
    for (const code of ["selection_changed", "output_too_long", "empty_reply", "refused", "credential_rejected", "cap_reached", "api_unreachable", "stopped", "something_new"]) {
      const text = handFailureText(code);
      expect(text).not.toMatch(/_/);
      expect(text.length).toBeGreaterThan(5);
    }
  });
});
