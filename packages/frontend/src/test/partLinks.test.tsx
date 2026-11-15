// `[[筆記/段落開頭]]` as the app draws it (docs/architecture/proposals/block-anchors-2026-11-01.md §0.5, §7, §12 批 2):
// one reading (lib/blockLinks over @onden/markdown blockLink.ts) behind the reading view, the editor, a backlink's excerpt
// and the embed, from the anchors and bindings the sync brought — no network, so it is also what an offline reader sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { BacklinkSnippetView } from "../components/BacklinkSnippetView";
import { editorPartLinks } from "../lib/editorPartLinks";
import { findBacklinkSnippet } from "../lib/backlinks";
import { resolveEmbed, embedExcerpt } from "../lib/embeds";
import { holdAnchored } from "./helpers/anchoredText";
import { replaceAllAnchors, replaceAllBindings, type NoteAnchor } from "../lib/blockAnchorStore";
import { partLinkWords } from "../lib/blockLinks";
import { loadPartLinks } from "../lib/partLinkModule";
import { blockLinkWriter } from "../lib/data";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ canEdit: (n: { space_id?: string }) => n.space_id !== "ro" }) }));

const MEAL = "# 晚餐\n\n17:45–21:15 吃飯，很久。\n\n下次少點一道菜。\n";
const node = (id: string, title: string, markdown: string, over: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, slug: id, markdown, source_type: "manual", node_type: "content", space_id: "s", ...over }) as ContentNode;
const meal = node("n1", "吃飯紀錄", MEAL);
const source = node("n2", "來源", "看 [[吃飯紀錄/舊的開頭]] 這段。");
const from = MEAL.indexOf("17:45");
const to = from + "17:45–21:15 吃飯，很久。".length;
const anchor = (over: Partial<NoteAnchor> = {}): NoteAnchor => ({
  anchor_id: "a1", note_id: "n1", from, to, status: "valid", candidate_from: null, candidate_to: null, quote: "17:45–21:15 吃飯，很久。", ...over,
});
const bind = (text = "吃飯紀錄/舊的開頭") => replaceAllBindings([{ note_id: "n2", link_text: text, anchor_id: "a1" }]);
const WORDS = "吃飯紀錄 › 17:45–21:15 吃飯，很久。";

beforeEach(async () => { await loadPartLinks(); resetAppState(); setLocalePref("zh-TW"); replaceAllAnchors([]); replaceAllBindings([]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); setLocalePref("en"); window.sessionStorage.clear(); });

function read(nodes: ContentNode[], text = source.markdown, onNavigate = vi.fn()) {
  setAppState({ data: { ...noWorkspaceData, nodes } });
  const utils = render(<MarkdownRenderer nodes={nodes} from={source} onNavigate={onNavigate}>{text}</MarkdownRenderer>);
  return { ...utils, onNavigate };
}

describe("the reading view", () => {
  it("shows 「筆記 › 開頭」 from the paragraph as it is now, though the link was written with other words", () => {
    replaceAllAnchors([anchor()]); bind();
    read([meal, source]);
    expect(screen.getByRole("button", { name: WORDS })).toBeTruthy();
    expect(document.body.textContent).not.toContain("舊的開頭");
  });

  it("opens the note with the caret on the paragraph", () => {
    replaceAllAnchors([anchor()]); bind();
    const { onNavigate } = read([meal, source]);
    fireEvent.click(screen.getByRole("button", { name: WORDS }));
    expect(onNavigate).toHaveBeenCalledWith("n1", "n1", undefined, undefined);
    expect(JSON.parse(window.sessionStorage.getItem("onden.pendingCursor.n1") ?? "null")).toEqual({ anchor: from, head: from });
  });

  it("a link nobody bound is found by its words, like one typed by hand", () => {
    read([meal, source], "[[吃飯紀錄/下次]]");
    expect(screen.getByRole("button", { name: "吃飯紀錄 › 下次少點一道菜。" })).toBeTruthy();
  });

  it("a heading renamed after the link was made is still reached through its binding", () => {
    const renamed = node("n1", "吃飯紀錄", "# 晚餐與宵夜\n\n內文。\n");
    replaceAllAnchors([anchor({ from: 0, to: 4, quote: "# 晚餐" })]);
    replaceAllBindings([{ note_id: "n2", link_text: "吃飯紀錄/晚餐", anchor_id: "a1" }]);
    read([renamed, source], "[[吃飯紀錄/晚餐]]");
    expect(screen.getByRole("button", { name: "吃飯紀錄 › 晚餐與宵夜" })).toBeTruthy();
  });

  it("「可能在這裡」: the link opens the probable paragraph; whoever may edit confirms it in one tap", async () => {
    replaceAllAnchors([anchor({ status: "maybe", from: 0, to: 4, candidate_from: from, candidate_to: to })]); bind();
    const confirm = vi.spyOn(blockLinkWriter, "confirm").mockResolvedValue(true);
    read([meal, source]);
    expect(await screen.findByText("可能在這裡")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "就是這段" }));
    expect(confirm).toHaveBeenCalledWith("n1", "a1");
  });

  it("「可能在這裡」 for a note the reader may only read: the hint, no button", async () => {
    const readOnly = node("n1", "吃飯紀錄", MEAL, { space_id: "ro" });
    replaceAllAnchors([anchor({ status: "maybe", from: 0, to: 4, candidate_from: from, candidate_to: to })]); bind();
    read([readOnly, source]);
    expect(await screen.findByText("可能在這裡")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "就是這段" })).toBeNull();
  });

  it("lost: the link falls back to the note itself, never to another paragraph", async () => {
    replaceAllAnchors([anchor({ status: "lost" })]); bind();
    const { onNavigate } = read([meal, source]);
    expect(await screen.findByText("段落已不存在")).toBeTruthy();
    expect(screen.queryByText("也許是這段")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "吃飯紀錄" }));
    expect(onNavigate).toHaveBeenCalledWith("n1", "n1", undefined, undefined);
    expect(window.sessionStorage.getItem("onden.pendingCursor.n1")).toBeNull();
    expect(document.body.textContent).not.toContain("下次少點");
  });

  it("lost with a best guess: the note, 「段落已不存在」 and 「也許是這段」 for whoever may confirm it", async () => {
    replaceAllAnchors([anchor({ status: "lost", from: 0, to: 4, candidate_from: from, candidate_to: to })]); bind();
    const confirm = vi.spyOn(blockLinkWriter, "confirm").mockResolvedValue(true);
    read([meal, source]);
    expect(await screen.findByText("段落已不存在")).toBeTruthy();
    expect(screen.getByText("也許是這段")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "就是這段" }));
    expect(confirm).toHaveBeenCalledWith("n1", "a1");
  });

  it("a deleted paragraph shows its old words struck through, and cannot be followed", async () => {
    replaceAllAnchors([anchor()]); bind();
    const trashed = node("n1", "吃飯紀錄", MEAL, { deleted_at: "2026-11-02T00:00:00Z" });
    read([trashed, source]);
    await waitFor(() => expect(document.querySelector(".wikilink-token--deleted s")).toBeTruthy());
    const struck = document.querySelector(".wikilink-token--deleted s");
    expect(struck?.textContent).toBe("17:45–21:15 吃飯，很久。");
    expect(document.body.textContent).toContain("已刪除的段落");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("no access: 「無法存取的內容」, and neither the note's name nor the paragraph's words reach the page", async () => {
    replaceAllAnchors([anchor()]); bind();
    read([source]); // the reader holds no n1
    await waitFor(() => expect(document.body.textContent).toContain("無法存取的內容"));
    expect(document.body.textContent).not.toContain("吃飯");
    expect(document.body.textContent).not.toContain("17:45");
  });

  it("a note whose text is not downloaded yet reads as its name, never as deleted", () => {
    const slim = node("n1", "吃飯紀錄", "", { body_len: 400 });
    replaceAllAnchors([anchor()]); bind();
    read([slim, source]);
    expect(screen.getByRole("button", { name: "吃飯紀錄" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("已刪除");
  });

  it("the old [[筆記#^id]] still reads, as the note and the start of its paragraph", () => {
    const legacy = node("n1", "吃飯紀錄", holdAnchored("n1", "17:45 吃飯很久 ^k1\n"));
    read([legacy, source], "[[吃飯紀錄#^k1]]");
    expect(screen.getByRole("button", { name: "吃飯紀錄 › 17:45 吃飯很久" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("k1");
  });
});

describe("every place a part link is drawn says the same words", () => {
  const nodes = [meal, source];

  it("the editor, the reading view, a backlink's excerpt and the shared function agree", () => {
    replaceAllAnchors([anchor()]); bind();
    setAppState({ data: { ...noWorkspaceData, nodes } });
    const ctx = { nodes, from: source };
    const shared = partLinkWords("吃飯紀錄/舊的開頭", ctx);
    expect(shared).toBe(WORDS);

    // reading view
    read(nodes);
    expect(screen.getByRole("button", { name: shared! })).toBeTruthy();
    cleanup();

    // backlink excerpt
    const snippet = findBacklinkSnippet(source, meal)!;
    expect(snippet).toBeNull(); // a part link is a reference to the paragraph, not a note-name backlink
    const raw = { text: source.markdown, linkStart: 2, linkEnd: 2 + "[[吃飯紀錄/舊的開頭]]".length, linkAbsStart: 2, truncatedStart: false, truncatedEnd: false, source: { id: "n2", space_id: "s" } };
    const { container } = render(<BacklinkSnippetView snippet={raw} />);
    expect(container.textContent).toContain(shared!);
    cleanup();

    // editor
    const view = new EditorView({
      state: EditorState.create({ doc: source.markdown, extensions: [editorPartLinks(() => ({ nodes, from: source }))] }),
      parent: document.body,
    });
    expect(view.dom.textContent).toContain(shared!);
    expect(view.dom.textContent).not.toContain("舊的開頭");
    view.destroy();
  });

  it("the editor keeps the written words in the text and redraws when an anchor arrives", async () => {
    setAppState({ data: { ...noWorkspaceData, nodes } });
    const view = new EditorView({
      state: EditorState.create({ doc: "看 [[吃飯紀錄/舊的開頭]]", extensions: [editorPartLinks(() => ({ nodes, from: source }))] }),
      parent: document.body,
    });
    expect(view.dom.textContent).toContain("舊的開頭"); // nothing known yet: the words as written
    act(() => { replaceAllAnchors([anchor()]); bind(); });
    await waitFor(() => expect(view.dom.textContent).toContain(WORDS));
    expect(view.state.doc.toString()).toBe("看 [[吃飯紀錄/舊的開頭]]");
    view.destroy();
  });
});

describe("embeds", () => {
  it("![[筆記/段落]] shows that paragraph's current text, through the binding, and is not editable in place", () => {
    replaceAllAnchors([anchor()]); bind();
    const nodes = [meal, source];
    setAppState({ data: { ...noWorkspaceData, nodes } });
    const embed = resolveEmbed("吃飯紀錄/舊的開頭", source, nodes);
    expect(embed.kind).toBe("part");
    if (embed.kind !== "part") return;
    expect(embedExcerpt(embed, MEAL)?.text).toBe("17:45–21:15 吃飯，很久。");
    // The note's text changed since the row was read: the excerpt follows the text it is given.
    expect(embedExcerpt(embed, MEAL.replace("很久", "不久"))?.text).toBe("17:45–21:15 吃飯，很久。".replace("很久", "不久"));
  });

  it("an embed whose paragraph is gone is not an embed of the whole note", () => {
    replaceAllAnchors([anchor({ status: "lost" })]); bind();
    const nodes = [meal, source];
    setAppState({ data: { ...noWorkspaceData, nodes } });
    const embed = resolveEmbed("吃飯紀錄/舊的開頭", source, nodes);
    expect(embed.kind).toBe("note");
  });
});
