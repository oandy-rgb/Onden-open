import { describe, expect, it } from "vitest";
import { abortLive, beginLive, endLive, followPreview, pushPreview } from "../services/agentRuntime/api/liveRun.js";
import { BUILTIN_SKILLS, builtinSkill } from "../services/harness/builtinSkills.js";

describe("the live preview of a running selection action", () => {
  it("a follower gets what was written before it came, then each piece, then the end", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    beginLive(id);
    pushPreview(id, "短");
    const seen: string[] = [];
    const follow = followPreview(id, (e) => seen.push(e.kind === "text" ? e.text : "<end>"))!;
    expect(follow.text).toBe("短");
    pushPreview(id, "一點");
    endLive(id);
    expect(seen).toEqual(["一點", "<end>"]);
    pushPreview(id, "不該出現"); // after the end nothing is added
    expect(seen).toHaveLength(2);
  });

  it("nobody follows a run this process does not have", () => {
    expect(followPreview("00000000-0000-4000-8000-000000000002", () => {})).toBeNull();
    expect(abortLive("00000000-0000-4000-8000-000000000002")).toBe(false);
  });

  it("cancelling aborts the model call once, and not a run that has ended", () => {
    const id = "00000000-0000-4000-8000-000000000003";
    const signal = beginLive(id).signal;
    expect(abortLive(id)).toBe(true);
    expect(signal.aborted).toBe(true);
    endLive(id);
    expect(abortLive(id)).toBe(false);
  });
});

describe("the built-in skills a selection can be handed to", () => {
  it.each(["rewrite", "shorten", "expand", "fix", "translate", "explain"])("%s works on selected text", (id) => {
    const skill = builtinSkill(id)!;
    expect(skill.scopes).toContain("text");
    expect(skill.hidden).toBeFalsy();
    expect(skill.system()).toContain("<text>");
  });
  it("ids stay unique", () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
