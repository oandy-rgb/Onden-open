// @vitest-environment jsdom
// `![[Note#^id]]`, `![[Note#Heading]]` and `![[Note]]` show the source's text
// (lib/embeds embedExcerpt → lib/embedDom → MarkdownRenderer), in the preview
// and as the editor's block widget, and follow the source as it changes.

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ApiError, type ContentNode } from "../lib/api";

const { reads } = await import("../lib/data");
const { embedExcerpt, resolveEmbed, flattenEmbeds, NOTE_EXCERPT_LINES } = await import("../lib/embeds");
const { resetDrawingCache } = await import("../lib/embedSources");
const { editorEmbeds, embedLineRanges, refreshEmbeds, embedEditorFocus } = await import("../lib/editorEmbeds");
const { holdLegacyNote, holdAnchored } = await import("./helpers/anchoredText");
const { default: MarkdownRenderer } = await import("../components/MarkdownRenderer");
const { ZH_TW: zhTW } = await import("../lib/i18n.zh-TW");

// Fixtures are written in the old form (`text ^id`); a note's ids are its anchors, the text has none.
const note = (over: Partial<ContentNode> & { id: string; title: string }) =>
  holdLegacyNote({ slug: over.title.toLowerCase(), markdown: "", node_type: "content", ...over }) as unknown as ContentNode;
const source = note({ id: "s1", title: "Source", markdown: "Intro\n\nThe key idea. ^key\n\n- item ^it\n  - child\n\n## Goals\n\ngoal text\n\n## Next\n\nlater" });
const BLOCK = "![[Source#^key]]";

afterEach(() => resetDrawingCache());

describe("embedExcerpt (pure)", () => {
  const embed = (body: string) => resolveEmbed(body, null, [source]) as Exclude<ReturnType<typeof resolveEmbed>, { kind: "missing" | "task" }>;

  it("cuts a block, a list item with its children, and a heading's section", () => {
    expect(embedExcerpt(embed("Source#^key"), source.markdown)?.text).toBe("The key idea.");
    expect(embedExcerpt(embed("Source#^it"), source.markdown)?.text).toBe("- item\n  - child");
    expect(embedExcerpt(embed("Source#Goals"), source.markdown)?.text).toBe("## Goals\n\ngoal text");
    expect(embedExcerpt(embed("Source#^nope"), source.markdown)).toBeNull();
    expect(embedExcerpt(embed("Source#Nope"), source.markdown)).toBeNull();
  });

  it("a whole note shows its first lines and keeps the rest for Show more", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const cut = embedExcerpt(embed("Source"), long)!;
    expect(cut.more).toBe(true);
    expect(cut.text.split("\n")).toHaveLength(NOTE_EXCERPT_LINES);
    expect(cut.full).toBe(long);
    expect(embedExcerpt(embed("Source"), "short")).toMatchObject({ text: "short", more: false });
  });

  it("closes a code fence the cut would leave open", () => {
    const md = ["```", ...Array.from({ length: 30 }, (_, i) => `code ${i}`), "```"].join("\n");
    expect(embedExcerpt(embed("Source"), md)!.text.endsWith("\n```")).toBe(true);
  });

  it("an embed inside embedded text becomes a link (depth limit 1)", () => {
    expect(flattenEmbeds("see ![[Other#^x]] and [[Plain]] and ![[Img|a]]")).toBe("see [[Other#^x]] and [[Plain]] and [[Img|a]]");
    const looping = note({ id: "l1", title: "Loop", markdown: `again ![[Loop#^me]] ^me` });
    const e = resolveEmbed("Loop#^me", null, [looping]) as Exclude<ReturnType<typeof resolveEmbed>, { kind: "missing" | "task" }>;
    expect(embedExcerpt(e, looping.markdown)?.text).toBe("again [[Loop#^me]]");
  });
});

describe("preview", () => {
  it("shows the block read-only with a source line that opens the note at the block", async () => {
    expect(zhTW["Not found"]).toBeTruthy();
    const onNavigate = vi.fn();
    const { container, findByText } = render(
      <MarkdownRenderer nodes={[source]} onNavigate={onNavigate}>{`before\n\n${BLOCK}\n`}</MarkdownRenderer>,
    );
    await waitFor(() => expect(container.querySelector(".md-transclusion-body")?.textContent).toContain("The key idea."));
    expect(container.querySelector(".md-transclusion-body")?.textContent).not.toContain("^key");
    expect(container.textContent).not.toContain("![[");
    fireEvent.click(await findByText("— Source"));
    expect(onNavigate).toHaveBeenCalledWith("source", "s1", "key");
  });

  it("shows a heading's section and a whole note's lines with Show more", async () => {
    const long = note({ id: "n9", title: "Long", markdown: Array.from({ length: 25 }, (_, i) => `row ${i + 1}`).join("\n\n") });
    const { container, findByText } = render(
      <MarkdownRenderer nodes={[source, long]} onNavigate={() => {}}>{"![[Source#Goals]]\n\n![[Long]]"}</MarkdownRenderer>,
    );
    await waitFor(() => expect(container.textContent).toContain("goal text"));
    expect(container.textContent).not.toContain("later");
    // 25 paragraphs are 49 lines: the first 20 show. Each embed renders on its own, so wait for this one too.
    await waitFor(() => expect(container.textContent).toContain("row 10"));
    expect(container.textContent).not.toContain("row 25");
    fireEvent.click(await findByText("Show more"));
    await waitFor(() => expect(container.textContent).toContain("row 25"));
    expect((await findByText("Show less")).textContent).toBe("Show less");
  });

  it("follows the source when it changes (sync or a local edit)", async () => {
    const { container, rerender } = render(<MarkdownRenderer nodes={[source]} onNavigate={() => {}}>{BLOCK}</MarkdownRenderer>);
    await waitFor(() => expect(container.textContent).toContain("The key idea."));
    const edited = { ...source, markdown: source.markdown.replace("The key idea.", "The key idea, better.") };
    rerender(<MarkdownRenderer nodes={[edited]} onNavigate={() => {}}>{BLOCK}</MarkdownRenderer>);
    await waitFor(() => expect(container.textContent).toContain("The key idea, better."));
    expect(container.textContent).not.toContain("The key idea.");
    // The block is gone from the source (and from every other note): a quiet line saying it was deleted.
    rerender(<MarkdownRenderer nodes={[{ ...source, markdown: "nothing here" } as ContentNode]} onNavigate={() => {}}>{BLOCK}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-embed-notice")?.textContent).toBe("This paragraph was deleted"));
  });

  it("a block the note doesn't have says it was deleted; a note the reader cannot read says so, quietly", async () => {
    const slim = note({ id: "p1", title: "Private", markdown: "", body_len: 40 } as never);
    const read = vi.spyOn(reads.notes, "full").mockRejectedValue(new ApiError(403, "{}"));
    const { container } = render(
      <MarkdownRenderer nodes={[source, slim]} onNavigate={() => {}}>{"![[Source#^missing]]\n\n![[Private#^k]]"}</MarkdownRenderer>,
    );
    await waitFor(() => expect([...container.querySelectorAll(".md-embed-notice")].map((n) => n.textContent)).toEqual(["This paragraph was deleted", "Content you cannot access"]));
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("reads a slim source once through the data layer", async () => {
    const slim = note({ id: "p2", title: "Slim", markdown: "", body_len: 20 } as never);
    const read = vi.spyOn(reads.notes, "full").mockResolvedValue({ ...slim, markdown: holdAnchored(slim.id, "Remote text ^r") } as ContentNode);
    const { container } = render(
      <MarkdownRenderer nodes={[slim]} onNavigate={() => {}}>{"![[Slim#^r]]\n\n![[Slim#^r]]"}</MarkdownRenderer>,
    );
    await waitFor(() => expect(container.querySelectorAll(".md-transclusion-body")).toHaveLength(2));
    await waitFor(() => expect(container.textContent).toContain("Remote text"));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("an embed inside the embedded block is a link, not a second embed", async () => {
    const a = note({ id: "a1", title: "A", markdown: "Outer ![[B#^bb]] ^aa" });
    const b = note({ id: "b1", title: "B", markdown: "Inner text ^bb" });
    const { container } = render(<MarkdownRenderer nodes={[a, b]} onNavigate={() => {}}>{"![[A#^aa]]"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-transclusion-body")?.textContent).toContain("Outer"));
    expect(container.querySelectorAll(".md-transclusion")).toHaveLength(1);
    // The inner `![[B#^bb]]` became the link `[[B#^bb]]`, read as 「B › start of its paragraph」 (lib/blockLinks legacyBlockWords), not drawn as a second embed.
    await waitFor(() => expect(container.querySelector(".md-transclusion-body")?.textContent).toContain("Outer B › Inner text"));
    expect(container.querySelectorAll(".md-transclusion-body")).toHaveLength(1);
  });
});

describe("editor", () => {
  const views: EditorView[] = [];
  afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });
  let nodes: ContentNode[] = [source];
  const onOpen = vi.fn();
  const context = () => ({ nodes, from: null, onOpen });
  function open(doc: string, cursor = 0) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [editorEmbeds(context)] }) });
    views.push(view);
    return view;
  }

  it("shows the block while the caret is elsewhere and the text on its line", async () => {
    nodes = [source];
    const view = open(`top\n\n${BLOCK}\n\nbottom`);
    await waitFor(() => expect(view.dom.querySelector(".cm-embed .md-transclusion-body")?.textContent).toContain("The key idea."));
    expect(view.contentDOM.textContent).not.toContain(BLOCK);
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 }, effects: embedEditorFocus.of(true) }); });
    expect(view.dom.querySelector(".cm-embed")).toBeNull();
    expect(view.contentDOM.textContent).toContain(BLOCK);
    expect(embedLineRanges(view.state, context)).toEqual([]);
  });

  it("redraws when the source changes and keeps the widget when it doesn't", async () => {
    nodes = [source];
    const view = open(`top\n\n${BLOCK}\n\nbottom`);
    await waitFor(() => expect(view.dom.querySelector(".cm-embed")?.textContent).toContain("The key idea."));
    const widget = view.dom.querySelector(".cm-embed");
    act(() => { view.dispatch({ effects: refreshEmbeds.of(null) }); });
    expect(view.dom.querySelector(".cm-embed")).toBe(widget); // same source: same DOM
    nodes = [{ ...source, markdown: source.markdown.replace("The key idea.", "The key idea. Changed.") } as ContentNode];
    act(() => { view.dispatch({ effects: refreshEmbeds.of(null) }); });
    await waitFor(() => expect(view.dom.querySelector(".cm-embed")?.textContent).toContain("Changed."));
  });

  it("the source line opens the note at the block without moving the caret", async () => {
    nodes = [source];
    onOpen.mockClear();
    const view = open(`top\n\n${BLOCK}\n\nbottom`);
    const line = await waitFor(() => {
      const el = view.dom.querySelector(".md-embed-source");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(line);
    expect(onOpen).toHaveBeenCalledWith("s1", "key");
    expect(view.dom.querySelector(".cm-embed")).not.toBeNull();
  });

  it("an embed naming no note stays text", () => {
    nodes = [source];
    const view = open("![[Nowhere#^x]]");
    expect(view.dom.querySelector(".cm-embed")).toBeNull();
  });
});
