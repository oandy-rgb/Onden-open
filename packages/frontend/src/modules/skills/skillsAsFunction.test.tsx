// Skills are a feature, not a tag (docs/architecture/harness.md): 「當成技能」 in the
// info panel adds and removes the module's inside tag, which no list shows; the
// skill's fields, the skills page and a tag page's 「用到的技能」 all change the
// skill note's own settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readSkillSettings, skillNoteMarkdown } from "@onden/markdown";
import type { ContentNode, Tag } from "../../lib/api";
import { setData, setOnline } from "../../lib/appStore";
import { setLocalePref } from "../../lib/i18n";
import { tagWriter } from "../../lib/data/domainWriters";
import { editNoteText } from "../../lib/data/draftActions";
import { reads } from "../../lib/data";
import { isNoteSwitchTag, isTagShown, hiddenTags } from "../../lib/nodeTags";
import { offersTag } from "../../lib/tagSuggestions";
import { hashtagSuggestionTags } from "../../lib/moduleLibrary";
import { splitTagSections } from "../../lib/tagTree";
import { NOTE_COMMANDS, moduleStatusFor } from "../index";
import NoteSwitches, { useNoteSwitchList } from "../../components/NoteSwitches";
import TitleTagRow from "../../components/TitleTagRow";
import SkillsSettings from "./SkillsSettings";

vi.mock("../../lib/data/domainWriters", async (original) => ({
  ...await original<typeof import("../../lib/data/domainWriters")>(),
  tagWriter: { apply: vi.fn(), remove: vi.fn(), create: vi.fn() },
}));
vi.mock("../../lib/data/draftActions", async (original) => ({
  ...await original<typeof import("../../lib/data/draftActions")>(),
  editNoteText: vi.fn(),
}));

const tag = (id: string, name: string, extra: Partial<Tag> = {}): Tag => ({ id, name, color: "#888", schema_id: null, ...extra });
const SKILL_TAG = tag("t-skill", "技能", { schema_module: "skills", schema_id: "t-skill" });
const PAPER = tag("t-paper", "論文");
const OS = tag("t-os", "作業系統");
const node = (id: string, title: string, markdown: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, slug: id, markdown, source_type: "manual", node_type: "content", ...extra });
const skillNote = (id: string, title: string, settings: Parameters<typeof skillNoteMarkdown>[0] = { instructions: "Do it." }, tagged = true) =>
  node(id, title, skillNoteMarkdown(settings), tagged ? { label_tag_ids: [SKILL_TAG.id] } : {});

/** What the last editNoteText call would write, given the note's current text. */
function lastEdit(id: string, markdown: string): string {
  const call = vi.mocked(editNoteText).mock.calls.at(-1)!;
  expect(call[0]).toBe(id);
  return call[1](markdown);
}

function seed(nodes: ContentNode[], tags: Tag[] = [SKILL_TAG, PAPER, OS]) {
  setData((data) => ({ ...data, nodes, tags } as never));
}

beforeEach(() => {
  setLocalePref("zh-TW");
  setOnline(true);
  vi.mocked(tagWriter.apply).mockReset().mockResolvedValue({ status: "synced", value: undefined });
  vi.mocked(tagWriter.remove).mockReset().mockResolvedValue({ status: "synced", value: undefined });
  vi.mocked(editNoteText).mockReset().mockResolvedValue("applied");
});
afterEach(cleanup);

describe("#技能 is not a tag anywhere", () => {
  it("is never shown, offered, listed or suggested — not even by its full name", () => {
    expect(isNoteSwitchTag(SKILL_TAG)).toBe(true);
    expect(isTagShown(SKILL_TAG)).toBe(false);
    expect(offersTag(SKILL_TAG, "技能")).toBe(false);
    expect(offersTag(SKILL_TAG, "")).toBe(false);
    // The owner's 「已隱藏」 list is for tags the owner hid: not this one.
    expect(hiddenTags([SKILL_TAG, tag("t-h", "x", { hidden: true })]).map((t) => t.id)).toEqual(["t-h"]);
    const sections = splitTagSections([SKILL_TAG, PAPER]);
    expect([...sections.own, ...sections.fromModules, ...sections.removed, ...sections.hidden].map((t) => t.id)).toEqual(["t-paper"]);
  });

  it("is not in the 「#」 menu, and the menu does not offer to make it", () => {
    const status = moduleStatusFor(["skills"], []);
    const items = hashtagSuggestionTags([SKILL_TAG, PAPER], status, { canImport: true });
    expect(items.map((item) => item.name)).not.toContain("技能");
    expect(items.some((item) => item.module?.id === "skills")).toBe(false);
    const without = hashtagSuggestionTags([PAPER], status, { canImport: true });
    expect(without.some((item) => item.module?.id === "skills")).toBe(false);
  });

  it("shows no chip on the note and offers none in the add-tag list", () => {
    const note = skillNote("n1", "出考題");
    render(<TitleTagRow node={note} tags={[SKILL_TAG, PAPER]} onToggleTag={() => {}} />);
    expect(screen.queryByText(/技能/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /標籤|Tag/ }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "技能" } });
    expect(screen.queryByRole("option", { name: /技能|Skills/ })).toBeNull();
  });
});

function Switches({ note }: { note: ContentNode }) {
  const switches = useNoteSwitchList(note, true);
  return <NoteSwitches node={note} switches={switches} />;
}

describe("「當成技能」: off in the ⋯ menu, on in the info panel", () => {
  it("a note that is not a skill has no row; the ⋯ menu's command turns it on by adding the inside tag", async () => {
    const note = node("n1", "出考題", "Make questions.");
    seed([note]);
    const { container } = render(<Switches note={note} />);
    expect(container.textContent).toBe("");
    const command = NOTE_COMMANDS.find(({ command }) => command.id === "switch-skills")!.command;
    // Off, it is a row under 「還能用在這則」 in the 功能 tab (no tie to the note yet), not a ⋯ menu item.
    expect(command.row?.related?.(note, "")).toBe(false);
    expect(command.available!(note, note.markdown ?? "", { online: true })).toBe(true);
    await command.run({ node: note, open: vi.fn(), openNode: vi.fn(), refresh: vi.fn() });
    await waitFor(() => expect(tagWriter.apply).toHaveBeenCalledWith("n1", SKILL_TAG.id));
    expect(command.available!(skillNote("n2", "已是技能"), "", { online: true })).toBe(false);
  });

  it("turns it off by removing the tag; the fields are only there while it is on", async () => {
    const note = skillNote("n1", "出考題");
    seed([note]);
    render(<Switches note={note} />);
    const toggle = screen.getByRole("switch", { name: "當成技能" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("什麼時候用")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(tagWriter.remove).toHaveBeenCalledWith("n1", SKILL_TAG.id));
  });

  it("shows no switch for a note the person cannot edit, or a tag", () => {
    const tagNode = node("tg", "論文", "", { node_type: "class_tag" });
    const { container } = render(<NoteSwitches node={tagNode} switches={[]} />);
    expect(container.textContent).toBe("");
  });

  it("changes the skill's own settings: when to use it, which tags, and the AI switch", async () => {
    const note = skillNote("n1", "出考題", { instructions: "Make questions.", description: "出期中考題" , appliesTo: ["作業系統"] });
    seed([note]);
    render(<Switches note={note} />);
    const when = await screen.findByDisplayValue("出期中考題");
    fireEvent.change(when, { target: { value: "出期末考題" } });
    fireEvent.blur(when);
    expect(readSkillSettings(lastEdit("n1", note.markdown)).description).toBe("出期末考題");

    fireEvent.click(screen.getByRole("button", { name: "移除 #作業系統" }));
    expect(readSkillSettings(lastEdit("n1", note.markdown)).appliesTo).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "加上標籤" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "#論文" }));
    expect(readSkillSettings(lastEdit("n1", note.markdown)).appliesTo).toEqual(["作業系統", "論文"]);

    fireEvent.click(screen.getByRole("switch", { name: "給 AI 用" }));
    expect(readSkillSettings(lastEdit("n1", note.markdown)).ai).toBe("manual");
  });
});

describe("Settings › Features › Skills", () => {
  const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, description: "", kind: "note", scopes: [], output: "note", appliesTo: [], aiUse: true, ...extra,
  });

  it("lists your skills with their switch, the built-in ones separately, and changes the switch in the note", async () => {
    seed([
      skillNote("k1", "論文摘要", { instructions: "x", appliesTo: ["論文"] }),
      skillNote("k2", "出考題", { instructions: "y", ai: "manual" }),
    ]);
    vi.spyOn(reads.agentMentions, "skills").mockResolvedValue({ skills: [
      row("k1", "論文摘要", { appliesTo: [PAPER.id] }), row("k2", "出考題", { aiUse: false }),
      row("fix", "Fix", { kind: "builtin" }),
    ] } as never);
    const openNote = vi.fn();
    render(<SkillsSettings ctx={{ online: true, onClose: () => {}, onImportDone: () => {}, onConnect: () => {}, openNote }} />);
    expect(await screen.findByText("你的技能 · 2")).toBeTruthy();
    expect(screen.getByText("套用在 #論文")).toBeTruthy();
    expect(screen.getByText("只在你點名時用")).toBeTruthy();
    expect(screen.getByText("內建")).toBeTruthy();

    const first = screen.getByRole("switch", { name: "讓 AI 使用「論文摘要」" });
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "讓 AI 使用「出考題」" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(first);
    expect(readSkillSettings(lastEdit("k1", skillNote("k1", "論文摘要").markdown)).ai).toBe("manual");

    fireEvent.click(screen.getByText("出考題"));
    expect(openNote).toHaveBeenCalledWith("k2");
    // New skill and SKILL.md import are right there; nothing shows an id or a code.
    expect(screen.getByRole("button", { name: /新增技能/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /匯入 SKILL.md/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/k1|k2|ai_use|manual/);
    await act(async () => {});
  });
});
