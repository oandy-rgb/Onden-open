import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkillHandoffView } from "./SkillHandoffAction";
import { setLocalePref } from "../../lib/i18n";
import type { NoteSkill } from "../../lib/agentMentions";

const skill = (over: Partial<NoteSkill> = {}): NoteSkill => ({ id: "k1", name: "寫讀書心得", description: "", appliesTo: ["t1"], ...over });
const props = { offline: false, keptAwayIn: null, onHandOff: vi.fn() };

beforeEach(() => { setLocalePref("zh-TW"); props.onHandOff.mockReset(); });
afterEach(cleanup);

describe("the skill buttons under a note's properties", () => {
  it("shows 「交給 AI：技能名」 for each skill of the note's tags, and hands that skill over on press", () => {
    render(<SkillHandoffView {...props} offered={[skill(), skill({ id: "k2", name: "摘要" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "交給 AI：寫讀書心得" }));
    expect(props.onHandOff).toHaveBeenCalledWith(expect.objectContaining({ id: "k1" }));
    expect(screen.getByRole("button", { name: "交給 AI：摘要" })).toBeTruthy();
  });

  it("is disabled offline", () => {
    render(<SkillHandoffView {...props} offline offered={[skill()]} />);
    expect((screen.getByRole("button", { name: "交給 AI：寫讀書心得" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tells a skill kept in a private space why the AI can't see it, in plain words", () => {
    render(<SkillHandoffView {...props} offered={[]} keptAwayIn={{ kind: "personal", is_default: false, name: "p" }} />);
    expect(screen.getByText("AI 看不到這個技能")).toBeTruthy();
    const note = screen.getByRole("note", { hidden: true }).textContent!;
    expect(note).toContain("「只有我」");
    expect(note).toContain("AI 看不到它");
    expect(note).not.toMatch(/external_ai|[a-z]+_[a-z]+/);
  });

  it("draws nothing when there is nothing to say", () => {
    const { container } = render(<SkillHandoffView {...props} offered={[]} keptAwayIn={null} />);
    expect(container.textContent).toBe("");
  });
});
