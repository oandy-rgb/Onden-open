// 「最近存的段落」: the paragraphs a block link was copied for (lib/recentBlocksStore),
// remembered by copyBlockLink, and listed first by the `((` popup (hooks/useBlockRefs).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
const h = vi.hoisted(() => ({ body: vi.fn(), search: vi.fn() }));
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return {
    ...real,
    reads: {
      ...real.reads,
      people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) },
      notes: { ...real.reads.notes, body: h.body, search: h.search },
    },
  };
});
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ canEdit: (n: { space_id?: string }) => n.space_id !== "ro" }) }));

import { useBlockRefs, BLOCK_REF_PAUSE_MS } from "../hooks/useBlockRefs";
import { copyBlockLink, bindEditorNote } from "../lib/editorParagraphActions";
import { parseRecentBlocks, recentBlocksStore, rememberBlock, withRecentBlock, RECENT_BLOCKS_MAX } from "../lib/recentBlocksStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { getPrefJson, PREFS } from "../lib/prefs";
import { replaceAllAnchors } from "../lib/blockAnchorStore";
import { holdAnchored } from "./helpers/anchoredText";
import { editorAnchorsField, setEditorAnchors } from "../lib/editorAnchors";

beforeEach(async () => {
  vi.useRealTimers();
  localStorage.clear();
  serverPrefs = {};
  sendWrite.mockReset();
  sendWrite.mockImplementation(async (_m: string, path: string, body: { value: unknown }) => { serverPrefs[path.split("/").pop()!] = body.value; return { value: body.value }; });
  h.body.mockReset(); h.search.mockReset();
  bindAccountStorage("unit-test-account", "");
  recentBlocksStore.save(null);
  await recentBlocksStore.sync();
  serverPrefs = {};
  sendWrite.mockClear();
  resetAppState();
  setAppState({ online: true, data: { ...noWorkspaceData, nodes: [] } });
});
afterEach(() => { vi.useRealTimers(); replaceAllAnchors([]); });

const entry = (note: string, ref: string, at: number) => ({ note, ref, at });

describe("recent blocks list", () => {
  it("puts a saved paragraph first; saving it again moves it, never doubles it", () => {
    let list = withRecentBlock([], "n1", "a", 100);
    list = withRecentBlock(list, "n2", "b", 200);
    list = withRecentBlock(list, "n1", "a", 300);
    expect(list.map((e) => `${e.note}/${e.ref}`)).toEqual(["n1/a", "n2/b"]);
  });

  it("keeps the ten newest", () => {
    let list: ReturnType<typeof withRecentBlock> = [];
    for (let i = 0; i < 15; i++) list = withRecentBlock(list, "n", `r${i}`, 1000 + i);
    expect(list).toHaveLength(RECENT_BLOCKS_MAX);
    expect(list[0]!.ref).toBe("r14");
    expect(list.at(-1)!.ref).toBe("r5");
  });

  it("stays first when the clock went backwards", () => {
    const list = withRecentBlock([entry("n1", "a", 5000)], "n2", "b", 10);
    expect(list.map((e) => e.ref)).toEqual(["b", "a"]);
  });

  it("reads back only a well-formed list", () => {
    expect(parseRecentBlocks([entry("n", "a", 1), entry("n", "a", 5)])).toEqual([entry("n", "a", 5)]);
    for (const bad of [null, "x", {}, [{ note: "n" }], [entry("", "a", 1)], [entry("n", "a", 0)], [entry("n", "a", 1.5)], [entry("n", "x".repeat(65), 1)]]) {
      expect(parseRecentBlocks(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("recent blocks follow the account", () => {
  it("saves to the server and to this device's copy", async () => {
    rememberBlock("n1", "a", 1000);
    await waitFor(() => expect(serverPrefs.recentBlocks).toEqual([entry("n1", "a", 1000)]));
    expect((getPrefJson(PREFS.recentBlocks) as { value: unknown }).value).toEqual([entry("n1", "a", 1000)]);
  });

  it("keeps what another device saved while this one saves too, newest first", async () => {
    serverPrefs.recentBlocks = [entry("n9", "z", 5000), entry("n8", "y", 10)];
    rememberBlock("n1", "a", 6000);
    await waitFor(() => expect((serverPrefs.recentBlocks as unknown[]).length).toBe(3));
    expect((serverPrefs.recentBlocks as Array<{ ref: string }>).map((e) => e.ref)).toEqual(["a", "z", "y"]);
    expect(recentBlocksStore.get().value?.map((e) => e.ref)).toEqual(["a", "z", "y"]);
  });

  it("a device that was offline sends its list when it is back", async () => {
    sendWrite.mockRejectedValueOnce(new Error("offline"));
    rememberBlock("n1", "a", 1000);
    await waitFor(() => expect(recentBlocksStore.get().dirty).toBe(true));
    await act(async () => { await recentBlocksStore.sync(); });
    expect(serverPrefs.recentBlocks).toEqual([entry("n1", "a", 1000)]);
  });
});

describe("copyBlockLink", () => {
  function editor(doc: string, caret: number) {
    return new EditorView({ state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [editorAnchorsField] }) });
  }

  it("remembers a paragraph with an anchor by that anchor, under the note the editor is on", async () => {
    const view = editor("first\n\nsecond", 8);
    view.dispatch({ effects: setEditorAnchors.of([{ id: "k9", from: 7, to: 13 }]) });
    bindEditorNote(view, () => "note-1");
    await copyBlockLink(view, 8, "Title", async () => {});
    expect(recentBlocksStore.get().value).toEqual([expect.objectContaining({ note: "note-1", ref: "k9" })]);
    expect(recentBlocksStore.get().value?.[0]?.pending).toBeUndefined();
    view.destroy();
  });

  it("remembers one without an anchor by its words; copying it again keeps one entry", async () => {
    const view = editor("first\n\n- an item", 9);
    bindEditorNote(view, () => "note-1");
    await copyBlockLink(view, 9, "Title", async () => {});
    await copyBlockLink(view, 9, "Title", async () => { throw new Error("denied"); });
    const list = recentBlocksStore.get().value ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ note: "note-1", pending: { text: "an item", blockKind: "listItem", start: 7 } });
    view.destroy();
  });

  it("a heading, or an editor that says no note, is not remembered", async () => {
    const heading = editor("# Plan\n\nbody", 2);
    bindEditorNote(heading, () => "note-1");
    expect((await copyBlockLink(heading, 2, "T", async () => {}))?.link).toBe("[[T/Plan]]");
    const unbound = editor("words", 2);
    await copyBlockLink(unbound, 2, "T", async () => {});
    expect(recentBlocksStore.get().value ?? []).toEqual([]);
    heading.destroy(); unbound.destroy();
  });

  it("copies the link by the paragraph's words and writes nothing into the note", async () => {
    const view = editor("first\n\nsecond", 8);
    bindEditorNote(view, () => "note-1");
    const result = await copyBlockLink(view, 8, "Title", async () => {});
    expect(view.state.doc.toString()).toBe("first\n\nsecond");
    expect(result).toEqual({ link: "[[Title/second]]", copied: true });
    view.destroy();
  });

  it("says so when the clipboard refuses, with the link to copy by hand", async () => {
    const view = editor("only", 2);
    bindEditorNote(view, () => "n");
    const result = await copyBlockLink(view, 2, "T", async () => { throw new Error("denied"); });
    expect(result).toEqual({ link: "[[T/only]]", copied: false });
    view.destroy();
  });

  it("not for a part with no words to name it", async () => {
    const quote = editor("> quoted", 3);
    bindEditorNote(quote, () => "n");
    expect(await copyBlockLink(quote, 3, "T", async () => {})).toBeNull();
    const blank = editor("a\n\n\nb", 2);
    expect(await copyBlockLink(blank, 2, "T", async () => {})).toBeNull();
    quote.destroy(); blank.destroy();
  });
});

describe("useBlockRefs", () => {
  const node = (id: string, title: string, extra: Partial<ContentNode> = {}) => ({ id, title, markdown: "", node_type: "content", ...extra }) as ContentNode;
  const nodes = [node("cur", "Current"), node("a", "Alpha"), node("b", "Beta"), node("ro", "Locked", { space_id: "ro" })];
  const opts = { nodes, currentId: "cur", currentText: () => "my own text" };
  const bodies: Record<string, string> = { a: "alpha para about graphs\n\nmore", b: "beta graph text", ro: "locked graph" };
  const texts = (rows: Array<{ snippet: { text: string } }>) => rows.map((r) => r.snippet.text);

  beforeEach(() => {
    // Note a's paragraph "alpha para about graphs" is the anchor g1 (the text carries no id).
    bodies.a = holdAnchored("a", "alpha para about graphs ^g1\n\nmore");
    h.body.mockImplementation(async (n: { id: string }) => bodies[n.id] ?? null);
    h.search.mockImplementation(async () => ({ rows: [{ id: "b" }, { id: "ro" }], offline: false, fieldFilterSkipped: false }));
  });

  it("with nothing typed lists only the recent paragraphs, without searching", async () => {
    rememberBlock("a", "g1", 10);
    rememberBlock("a", "gone", 20);
    const { result } = renderHook(() => useBlockRefs({ type: "blockref", query: "" }, opts));
    await waitFor(() => expect(texts(result.current.rows)).toEqual(["alpha para about graphs"]));
    expect(result.current.rows[0]!.origin).toBe("recent");
    expect(h.search).not.toHaveBeenCalled();
  });

  it("lists recent matches first, then what the index found, each paragraph once, after a pause", async () => {
    rememberBlock("a", "g1", 10);
    const { result, rerender } = renderHook(({ q }) => useBlockRefs({ type: "blockref", query: q }, opts), { initialProps: { q: "g" } });
    // Typing on within the pause asks the index once, for the last words.
    rerender({ q: "gr" }); rerender({ q: "gra" });
    await waitFor(() => expect(texts(result.current.rows)).toEqual(["alpha para about graphs", "beta graph text", "locked graph"]));
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search.mock.calls[0]![0]).toBe("gra");
    expect(result.current.rows.map((r) => r.origin)).toEqual(["recent", "found", "found"]);
    expect(result.current.rows.map((r) => r.writable)).toEqual([true, true, false]);
    expect(BLOCK_REF_PAUSE_MS).toBeLessThan(300);
  });

  it("falls back to no rows when the index fails, and drops a recent whose note is gone", async () => {
    rememberBlock("missing-note", "x", 30);
    h.search.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useBlockRefs({ type: "blockref", query: "zzz" }, opts));
    await waitFor(() => expect(result.current.searching).toBe(false));
    expect(result.current.rows).toEqual([]);
  });

  it("gives the plain [[ list its recent paragraphs and nothing for other popups", async () => {
    rememberBlock("a", "g1", 10);
    const wiki = renderHook(() => useBlockRefs({ type: "wikilink", query: "" }, opts));
    await waitFor(() => expect(texts(wiki.result.current.recentForWikilink)).toEqual(["alpha para about graphs"]));
    expect(wiki.result.current.rows).toEqual([]);
    const tags = renderHook(() => useBlockRefs({ type: "hashtag", query: "" }, opts));
    expect(tags.result.current).toMatchObject({ rows: [], recentForWikilink: [] });
  });
});
