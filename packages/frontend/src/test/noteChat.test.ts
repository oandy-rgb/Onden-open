import { beforeEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../lib/i18n";
import type { HandOptions } from "../lib/handToAi";
import {
  addChip, additionAtEnd, barLine, chatEntry, chipsToScope, insertion, mentionQuery, removeChip, SCOPE_MAX, stepLine, suggestionLine,
  turnIsOpen, withoutAddition, withoutMention, type ScopeChip,
} from "../lib/noteChat";

// The rules of the info panel's AI tab, without React: scope chips, the `@` that adds one, who answers
// and why nobody can, what is shown while it works, and where an answer goes in the note.

beforeEach(() => setLocalePref("en"));

const note = (id: string): ScopeChip => ({ kind: "note", id, title: id });
const tag = (id: string): ScopeChip => ({ kind: "tag", id, title: id });
const options = (role: Partial<HandOptions["roles"][number]> = {}): HandOptions => ({
  can_hand_off: true,
  roles: [{ actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "api", reason: null, model_name: "m",
    runtimes: [{ kind: "api", available: true, unavailable_reason: null }, { kind: "mcp", available: false, unavailable_reason: "no_token" }], ...role }],
});
const why = (code: string | null) => `why:${code}`;

describe("scope chips", () => {
  it("add once, never the open note, never past the limit; remove by kind and id", () => {
    let chips: ScopeChip[] = [];
    chips = addChip(chips, note("a"), "open");
    chips = addChip(chips, note("a"), "open");
    chips = addChip(chips, note("open"), "open");
    chips = addChip(chips, tag("a"), "open"); // the same id as a note, but a tag: a different thing
    expect(chips).toEqual([note("a"), tag("a")]);
    for (let i = 0; i < 20; i++) chips = addChip(chips, note(`n${i}`), "open");
    expect(chips).toHaveLength(SCOPE_MAX);
    expect(removeChip(chips, note("a"))).not.toContainEqual(note("a"));
    expect(removeChip(chips, note("a"))).toContainEqual(tag("a"));
  });
  it("go to the server as note ids and tag ids", () => {
    expect(chipsToScope([note("a"), tag("t"), note("b")])).toEqual({ scope_note_ids: ["a", "b"], scope_tag_ids: ["t"] });
  });
});

describe("the @ that adds a chip", () => {
  it("is a word starting at the beginning or after a space, at the end of the question", () => {
    expect(mentionQuery("hello @pro")).toEqual({ query: "pro", start: 6 });
    expect(mentionQuery("@")).toEqual({ query: "", start: 0 });
    expect(mentionQuery("mail me@example")).toBeNull();
    expect(mentionQuery("@pro then more")).toBeNull();
  });
  it("is removed from the question when it becomes a chip", () => {
    const mention = mentionQuery("compare with @pro")!;
    expect(withoutMention("compare with @pro", mention)).toBe("compare with");
  });
});

describe("who answers, and why nobody can", () => {
  it("offline: a plain sentence, no role looked up", () => {
    expect(chatEntry({ online: false, options: options(), reasonText: why }).blocked).toBe("Asking the AI needs a connection.");
  });
  it("a role with a way that works answers on its default way; the person's pick wins while it works", () => {
    expect(chatEntry({ online: true, options: options(), reasonText: why }).target).toMatchObject({ runtime: "api" });
    const both = options({ runtimes: [{ kind: "api", available: true }, { kind: "mcp", available: true }] });
    expect(chatEntry({ online: true, options: both, pick: { runtime: "mcp" }, reasonText: why }).target).toMatchObject({ runtime: "mcp" });
  });
  it("a role with no working way says why, in the settings' words", () => {
    const stuck = options({ runtimes: [{ kind: "api", available: false, unavailable_reason: "no_key" }] });
    expect(chatEntry({ online: true, options: stuck, reasonText: why })).toEqual({ target: null, blocked: "why:no_key" });
  });
  it("no role, or a role that is off, says so", () => {
    expect(chatEntry({ online: true, options: { can_hand_off: true, roles: [] }, reasonText: why }).blocked).toMatch(/No AI is set up/);
    expect(chatEntry({ online: true, options: options({ reason: "disabled" }), reasonText: why }).blocked).toMatch(/switched off/);
  });
  it("before the roles are known, nothing is blocked and nobody is chosen", () => {
    expect(chatEntry({ online: true, options: null, reasonText: why })).toEqual({ target: null, blocked: null });
  });
});

describe("what is shown", () => {
  it("one line on what the AI is doing, naming the note only when there is a name", () => {
    expect(stepLine({ what: "read", title: "Plan" })).toBe("Reading “Plan”…");
    expect(stepLine({ what: "read", title: "" })).toBe("Reading “Untitled”…");
    expect(stepLine({ what: "read", title: null })).toBe("Reading…");
    expect(stepLine({ what: "search", title: null })).toBe("Searching…");
    expect(stepLine({ what: "write", title: "Plan" })).toBe("Preparing a change to “Plan”…");
  });
  it("how many changes it proposed, while they wait and after they were decided", () => {
    expect(suggestionLine({ suggestions: { pending: 3, accepted: 0, rejected: 0 } })).toBe("Suggested 3 changes");
    expect(suggestionLine({ suggestions: { pending: 0, accepted: 1, rejected: 1 } })).toBe("2 changes decided");
    expect(suggestionLine({ suggestions: { pending: 0, accepted: 0, rejected: 0 } })).toBe("");
  });
  it("an answer reads without its link brackets; an open turn is queued, delivered or running", () => {
    expect(barLine([{ status: "running", runtime: "api", created_at: "2026-11-01T00:00:00Z" } as never], "見 [[甲#^b1|那段]]、[[乙]] 和 [[丙#^c-2]]", 0)).toBe("見 那段、乙 和 丙"); // the bar shows an answer without link brackets
    expect(["queued", "delivered", "running"].every((status) => turnIsOpen({ status: status as never }))).toBe(true);
    expect(["completed", "failed", "cancelled"].some((status) => turnIsOpen({ status: status as never }))).toBe(false);
  });
});

describe("putting an answer into the note", () => {
  it("is added after what is there, set apart by a blank line, and taken out again exactly, only while it is as it was added", () => {
    for (const body of ["# 標題\n\n第一段", "# 標題\n\n第一段\n", "# 標題\n\n第一段\n\n", ""]) {
      const added = additionAtEnd(body, "答案");
      expect(added.startsWith("\n") || body === "" || body.endsWith("\n\n")).toBe(true);
      expect(withoutAddition(body + added, added)).toBe(body); // undo gives back the very same text
    }
    expect(additionAtEnd("第一段", "答案")).toBe("\n\n答案\n");
    expect(additionAtEnd("第一段\n", "答案")).toBe("\n答案\n");
    const added = additionAtEnd("內文", "答案");
    expect(withoutAddition(("內文" + added).replace("答案", "答案，我改過"), added)).toBeNull(); // changed since: left alone
  });
  it("takes out the last copy when the same answer was put in twice", () => {
    const first = additionAtEnd("內文", "答案");
    const second = additionAtEnd("內文" + first, "答案");
    expect(withoutAddition("內文" + first + second, second)).toBe("內文" + first);
  });
  it("is the same text at the caret as at the end of a note that ends without a newline", () => {
    expect(insertion("  答案 \n")).toBe("\n\n答案\n");
    expect(insertion("答案")).toBe(additionAtEnd("x", "答案"));
  });
});
