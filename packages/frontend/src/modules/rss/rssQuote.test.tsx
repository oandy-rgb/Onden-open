import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Quote, don't hoard:
//   * selecting text offers 「放進今天的日記」, 「放進〈上次用的筆記〉」 and 「別篇筆記…」;
//     each APPENDS an excerpt (@onden/markdown excerpt.ts: a quote, its source
//     link with a Text Fragment) to the end of that note;
//   * the append goes through the note writer, so offline it is queued, and
//     it never overwrites (base_markdown lets the server merge);
//   * one undo step removes exactly the appended text;
//   * a passage this device already holds an excerpt of is not written twice;
//   * keeping the whole article is demoted: no save control beside the
//     title, a secondary one at the end after 「寫點什麼」;
//   * 「寫點什麼」 starts a draft with embeds of this session's excerpts, or
//     appends them.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
  upsertNode: vi.fn(async () => null),
  removeNode: vi.fn(async () => null),
}));

import RssReaderPanel from "./RssReaderPanel";
import { appendedBody } from "@onden/markdown";
import { appendQuote, draftBlock, knownExcerpt, loadPageExcerpts, quoteSourceLine } from "./rssQuote";
import { excerptBlock, parseExcerpts } from "@onden/markdown";
import { replaceAllAnchors } from "../../lib/blockAnchorStore";
import { addPendingWrite } from "../../lib/localDb";
import { bindAccountStorage } from "../../lib/accountStorage";
import { noWorkspaceData, type ContentNode } from "../../lib/api";
import { getAppState, resetAppState } from "../../lib/appStore";
import "../../modules"; // the module registry (the 日記 switch reads it)

bindAccountStorage("unit-test-account", "");

const note = (id: string, title: string, markdown: string) =>
  ({ id, title, markdown, slug: id, node_type: "content", source_type: "manual", parent_id: null }) as unknown as ContentNode;

const ARTICLE = {
  id: "art-1", title: "An Article", source_id: "s1", url: "https://example.com/a",
  published_at: null, fetched_at: "2026-06-30T00:00:00Z", seen: false, saved_node_id: null,
  body: "<p>The quick brown fox jumps over the lazy dog and keeps on running.</p>",
};
const FEED = {
  id: "s1", title: "Daily News", url: "https://example.com/feed.xml", fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 1, created_at: "2026-10-01T00:00:00Z",
  save_default: { tag_ids: [], parent_id: "reading-notes", parent_title: "Reading notes", origin: "source" },
};
const SOURCE = { title: "An Article", url: "https://example.com/a", feed: "Daily News" };

let online = true;
const writes = () => vi.mocked(addPendingWrite).mock.calls.map((c) => ({ method: c[0], path: c[1], body: JSON.parse(String(c[2])) }));
const sent = () => apiMock.mock.calls.filter((c) => c[1]?.method && c[1].method !== "GET")
  .map((c) => ({ method: c[1].method as string, path: c[0] as string, body: JSON.parse(String(c[1].body)) }));

beforeEach(() => {
  localStorage.clear();
  online = true;
  resetAppState({ data: { ...noWorkspaceData, nodes: [note("reading-notes", "Reading notes", "# Reading notes\n\nEarlier thoughts.\n"), note("other", "Other note", "")] }, online: true });
  vi.mocked(addPendingWrite).mockClear();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      if (!online) throw new TypeError("Failed to fetch"); // offline transport
      const body = JSON.parse(String(init.body ?? "{}"));
      if (path.startsWith("/api/nodes/")) {
        const id = path.split("/").pop()!;
        return { ...note(id, getAppState().data.nodes.find((n) => n.id === id)?.title ?? "x", body.markdown ?? ""), ...body };
      }
      if (path === "/api/nodes") return { ...note(body.id, body.title, body.markdown), ...body };
      return {};
    }
    if (path.startsWith("/api/rss/sources")) return { sources: [FEED], total_unseen: 1, module_default: null };
    if (path === "/api/rss/items/art-1") return ARTICLE;
    if (path.startsWith("/api/rss/items")) return { items: [ARTICLE], next_cursor: null };
    return {};
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // The reader's leftover history entry is taken off just after unmount; let that popstate land here, not in the next test.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

const PASSAGE = { text: "The quick brown fox", prefix: "", suffix: "jumps over the lazy dog and" };
const EXCERPT = /> The quick brown fox\n>\n> — \[An Article\]\(https:\/\/example\.com\/a#:~:text=The%20quick%20brown%20fox,-jumps%20over%20the%20lazy%20dog%20and\) · Daily News\n$/;

describe("the appended text", () => {
  it("is an excerpt after the note's last text, with one blank line between", () => {
    expect(appendedBody("# Notes\n\nOld.\n\n\n", "> q\n>\n> — src")).toBe("# Notes\n\nOld.\n\n> q\n>\n> — src\n");
    expect(appendedBody("", "> q")).toBe("> q\n");
    expect(quoteSourceLine({ title: " ", url: null, feed: "" })).toBe("— Untitled");
    expect(draftBlock([], SOURCE)).toBe("— [An Article](https://example.com/a) · Daily News");
    expect(draftBlock(["![[A#^x]]", "![[A#^y]]"], SOURCE)).toBe("![[A#^x]]\n\n![[A#^y]]");
  });

  it("is appended through the note writer with the body it was read from (never an overwrite)", async () => {
    const r = await appendQuote("reading-notes", { passage: PASSAGE, source: SOURCE });
    expect(r.status).toBe("synced");
    const [patch] = sent();
    expect(patch!.method).toBe("PATCH");
    expect(patch!.path).toBe("/api/nodes/reading-notes");
    expect(patch!.body.base_markdown).toBe("# Reading notes\n\nEarlier thoughts.\n");
    expect(patch!.body.markdown).toMatch(new RegExp(`^# Reading notes\\n\\nEarlier thoughts\\.\\n\\n${EXCERPT.source}`));
    // What was written reads back as that excerpt (it is anchored by the server; here by an anchor at the quote), and the
    // append reports the words an embed of it goes by.
    expect(r.words).toBe(PASSAGE.text);
    const at = (patch!.body.markdown as string).indexOf("> The quick");
    expect(parseExcerpts(patch!.body.markdown, [{ id: "x1", from: at, to: patch!.body.markdown.length }])).toEqual([expect.objectContaining({ id: "x1", exact: PASSAGE.text, suffix: PASSAGE.suffix, url: "https://example.com/a", title: "An Article", feed: "Daily News" })]);
  });

  it("offline, the append is queued with its base, and the note shows it at once", async () => {
    online = false;
    const r = await appendQuote("reading-notes", { passage: PASSAGE, source: SOURCE });
    expect(r.status).toBe("queued");
    const queued = writes().find((w) => w.path === "/api/nodes/reading-notes")!;
    expect(queued.method).toBe("PATCH");
    expect(queued.body.base_markdown).toBe("# Reading notes\n\nEarlier thoughts.\n");
    expect(queued.body.markdown).toMatch(/> The quick brown fox\n>\n> — \[An Article\]/);
    expect(getAppState().data.nodes.find((n) => n.id === "reading-notes")!.markdown).toMatch(/> The quick brown fox/);
  });

  it("undo is one step that removes exactly the appended text, keeping later edits", async () => {
    const r = await appendQuote("reading-notes", { passage: PASSAGE, source: SOURCE });
    // Someone edits the top of the note meanwhile.
    act(() => {
      const nodes = getAppState().data.nodes.map((n) => n.id === "reading-notes" ? { ...n, markdown: `# Reading notes (edited)${n.markdown.slice("# Reading notes".length)}` } : n);
      resetAppState({ data: { ...getAppState().data, nodes }, online: true });
    });
    expect(await r.undo()).toBe(true);
    const undo = sent().at(-1)!;
    expect(undo.body.markdown).toBe("# Reading notes (edited)\n\nEarlier thoughts.\n");
    expect(undo.body.base_markdown).toMatch(/> The quick brown fox/);
    // Already gone: nothing to remove, nothing sent.
    const before = sent().length;
    expect(await r.undo()).toBe(false);
    expect(sent()).toHaveLength(before);
  });
});

/** The server anchored the quote at the start of its block: note `noteId`'s anchor `id` (what the store brings with the sync). */
const held = (noteId: string, markdown: string, id: string) => {
  const from = markdown.indexOf("> ");
  replaceAllAnchors([{ anchor_id: id, note_id: noteId, from, to: markdown.length - 1, status: "valid", candidate_from: null, candidate_to: null, quote: markdown.slice(from, from + 40) }], [noteId]);
};

describe("a passage already held as an excerpt", () => {
  const withExcerpt = () => {
    const markdown = `# Seen\n\n${excerptBlock({ exact: PASSAGE.text }, SOURCE)}\n`;
    held("seen", markdown, "k1");
    resetAppState({ data: { ...getAppState().data, nodes: [...getAppState().data.nodes, note("seen", "Seen", markdown)] }, online: true });
  };

  it("is found in a note the store holds, for the same page and text only", async () => {
    withExcerpt();
    const known = await loadPageExcerpts("https://example.com/a#section");
    expect(knownExcerpt(known, "https://example.com/a#section", "The  quick brown fox")).toMatchObject({ noteId: "seen", excerpt: { id: "k1" } });
    expect(knownExcerpt(known, "https://example.com/a", "keeps on running")).toBeNull();
    expect(knownExcerpt(known, null, PASSAGE.text)).toBeNull();
    expect(await loadPageExcerpts("https://example.com/b")).toEqual([]);
    expect(await loadPageExcerpts(null)).toEqual([]);
  });

  it("is found by search when its note is held without text; a failed search just finds nothing", async () => {
    const slim = { ...note("slim", "Slim", ""), body_len: 400 } as unknown as ContentNode;
    resetAppState({ data: { ...getAppState().data, nodes: [...getAppState().data.nodes, slim] }, online: true });
    const fullText = `${excerptBlock({ exact: PASSAGE.text }, SOURCE)}\n`;
    held("slim", fullText, "k2");
    const full = { ...note("slim", "Slim", fullText), body_len: 400 };
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/nodes/search")) return [{ id: "slim", title: "Slim", node_type: "content", snippet: { text: "", ranges: [] } }];
      if (path === "/api/nodes/slim") return full;
      return {};
    });
    expect(knownExcerpt(await loadPageExcerpts("https://example.com/a"), "https://example.com/a", PASSAGE.text)).toMatchObject({ noteId: "slim", excerpt: { id: "k2" } });
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await loadPageExcerpts("https://example.com/a")).toEqual([]);
  });
});

async function openArticle() {
  const view = render(<RssReaderPanel online onOpenNode={onOpenNode} initialItemId="art-1" />);
  await screen.findByRole("heading", { name: "An Article" });
  // The feed list (with its default parent note) has arrived.
  await screen.findByRole("button", { name: "Daily News" });
  return view;
}
const onOpenNode = vi.fn();

function select(text: string) {
  const body = document.querySelector(".rss-article-body")!;
  // A real range over the text, so the words around it are the article's own.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.textContent!.indexOf(text);
    if (at >= 0) { range.setStart(n, at); range.setEnd(n, at + text.length); break; }
  }
  vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => text, anchorNode: body, rangeCount: 1, getRangeAt: () => range, removeAllRanges: () => {},
  } as unknown as Selection);
  fireEvent(document, new Event("selectionchange"));
}

const bar = () => screen.findByRole("toolbar", { name: "Selected text" });

describe("the reader's 放進筆記", () => {
  it("a selection offers today's note, the last-used note and another note", async () => {
    await openArticle();
    select("The quick brown fox");
    const options = within(await bar());
    expect(options.getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Put in today's note", "Put in “Reading notes”", "Another note…", "See less like this"]);
    expect(options.getByRole("button", { name: "Put in today's note" }).className).toMatch(/rss-quote-main/);
  });

  it("the last-used note puts an excerpt (with the words around it) at the end of that note, with 復原", async () => {
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Reading notes”" }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/reading-notes")).toBe(true));
    const patch = sent().find((w) => w.path === "/api/nodes/reading-notes")!;
    expect(patch.body.markdown).toMatch(/Earlier thoughts\.\n\n> The quick brown fox\n>\n> — \[An Article\]\(https:\/\/example\.com\/a#:~:text=The%20quick%20brown%20fox,-jumps%20over%20the%20lazy%20dog%20and\) · Daily News\n$/);
    // The whole article was not saved: quoting is not hoarding.
    expect(sent().some((w) => w.path.endsWith("/save"))).toBe(false);
    const toast = getAppState().toasts.find((t) => t.action)!;
    expect(toast.message).toBe("Added to “Reading notes”.");
    expect(toast.action!.label).toBe("Undo");
    await act(async () => { toast.action!.onClick(); });
    await waitFor(() => expect(sent().at(-1)!.body.markdown).toBe("# Reading notes\n\nEarlier thoughts.\n"));
  });

  it("today's note leads: it is started when there is none, and the excerpt goes into it", async () => {
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in today's note" }));
    await waitFor(() => expect(sent().some((w) => w.method === "PATCH")).toBe(true));
    const create = sent().find((w) => w.method === "POST" && w.path === "/api/nodes")!;
    expect(create.body.title).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const patch = sent().find((w) => w.method === "PATCH")!;
    expect(patch.path).toBe(`/api/nodes/${create.body.id}`);
    expect(patch.body.markdown).toMatch(/^> The quick brown fox\n>\n> — \[An Article\]/);
    expect(getAppState().toasts.find((t) => t.action)?.message).toBe(`Added to “${create.body.title}”.`);
  });

  it("with the 日記 module off, today's note is not offered and the last-used note leads", async () => {
    resetAppState({ data: { ...getAppState().data, workspace: { ...getAppState().data.workspace, modules: ["tasks"] } }, online: true });
    await openArticle();
    select("The quick brown fox");
    const options = within(await bar());
    expect(options.queryByRole("button", { name: "Put in today's note" })).toBeNull();
    expect(options.getByRole("button", { name: "Put in “Reading notes”" }).className).toMatch(/rss-quote-main/);
  });

  it("another note… picks one, which then becomes the last-used note", async () => {
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Another note…" }));
    const sheet = await screen.findByRole("dialog", { name: "Put it in…" });
    await userEvent.click(within(sheet).getByRole("option", { name: /Other note/ }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/other")).toBe(true));
    expect(sent().find((w) => w.path === "/api/nodes/other")!.body.markdown).toMatch(/^> The quick brown fox\n>\n> — \[An Article\]/);

    select("keeps on running");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Other note”" }));
    await waitFor(() => expect(sent().filter((w) => w.path === "/api/nodes/other")).toHaveLength(2));
  });

  it("the first tap never waits on the lookup: while it is still running the passage is simply written", async () => {
    const slim = { ...note("slim", "Slim", ""), body_len: 400 } as unknown as ContentNode;
    resetAppState({ data: { ...getAppState().data, nodes: [...getAppState().data.nodes, slim] }, online: true });
    let release!: (rows: unknown[]) => void;
    const defaults = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path.startsWith("/api/nodes/search")) return new Promise((resolve) => { release = resolve; });
      return defaults(path, ...rest);
    });
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Reading notes”" }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/reading-notes")).toBe(true));
    release([]);
  });

  it("two quick taps write one excerpt, even while today's note is being opened", async () => {
    await openArticle();
    select("The quick brown fox");
    const today = within(await bar()).getByRole("button", { name: "Put in today's note" });
    await act(async () => { fireEvent.click(today); fireEvent.click(today); });
    await waitFor(() => expect(sent().some((w) => w.method === "PATCH")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent().filter((w) => w.method === "PATCH")).toHaveLength(1);
    expect(sent().filter((w) => w.method === "POST" && w.path === "/api/nodes")).toHaveLength(1);
  });

  it("an excerpt written in this session is known at once: the same passage is not written again", async () => {
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Reading notes”" }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/reading-notes")).toBe(true));
    const before = sent().length;
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Reading notes”" }));
    expect(await within(await bar()).findByText("Already in “Reading notes”")).toBeInTheDocument();
    expect(sent()).toHaveLength(before);
  });

  it("a passage already held as an excerpt is not written again: the bar says where, and offers to open or embed it", async () => {
    const markdown = `# Seen\n\n${excerptBlock({ exact: "The quick brown fox" }, SOURCE)}\n`;
    held("seen", markdown, "k1");
    resetAppState({ data: { ...getAppState().data, nodes: [...getAppState().data.nodes, note("seen", "Seen", markdown)] }, online: true });
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Reading notes”" }));
    expect(await within(await bar()).findByText("Already in “Seen”")).toBeInTheDocument();
    expect(sent().filter((w) => w.path.startsWith("/api/nodes"))).toHaveLength(0);

    await userEvent.click(within(await bar()).getByRole("button", { name: "Open “Seen”" }));
    expect(onOpenNode).toHaveBeenCalledWith("seen");

    await userEvent.click(within(await bar()).getByRole("button", { name: "Quote it in another note…" }));
    const sheet = await screen.findByRole("dialog", { name: "Put it in…" });
    await userEvent.click(within(sheet).getByRole("option", { name: /Other note/ }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/other")).toBe(true));
    expect(sent().find((w) => w.path === "/api/nodes/other")!.body.markdown).toBe("![[Seen/The quick brown fox]]\n");
    expect(sent().some((w) => w.path === "/api/nodes/seen")).toBe(false);
  });
});

describe("the end of an article", () => {
  it("leads with 寫點什麼; saving the whole article is only a secondary control there", async () => {
    await openArticle();
    expect(document.querySelector(".rss-article-head .rss-save-ctl")).toBeNull();
    const end = document.querySelector<HTMLElement>(".rss-article-end")!;
    const write = within(end).getByRole("button", { name: /Write something/ });
    const save = within(end).getByRole("button", { name: /Save to notes/ });
    expect(write.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(write.className).toMatch(/primary/);
  });

  it("寫點什麼 and 存成筆記 share one row at the same small size; the choices open below it", async () => {
    await openArticle();
    const row = document.querySelector<HTMLElement>(".rss-article-end .rss-end-actions")!;
    const write = within(row).getByRole("button", { name: /Write something/ });
    const save = within(row).getByRole("button", { name: /Save to notes/ });
    const more = within(row).getByRole("button", { name: "Choose where to save" });
    for (const b of [write, save, more]) {
      expect(b.className).toMatch(/ui-btn--sm/);
      expect(b.className).toMatch(/rss-end-btn/);
    }
    expect(write.className).toMatch(/primary/);
    expect(save.className).toMatch(/secondary/);
    expect(save.className).not.toMatch(/rss-write-btn/);
    expect(document.querySelector(".rss-write-choice")).toBeNull();
    await userEvent.click(write);
    const choice = row.querySelector(".rss-write-choice")!;
    expect(choice).toBeInTheDocument();
    // The choices follow the buttons in the DOM and do not sit between them.
    expect(save.compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(write.nextElementSibling).not.toBe(choice);
    expect(within(row).getByText(/^→ /)).toBeInTheDocument();
  });

  it("寫點什麼 › 新草稿 creates a note embedding this session's excerpts at the default destination and opens it", async () => {
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Reading notes”" }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/reading-notes")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /Write something/ }));
    expect(screen.getByText("With your 1 quote from this article and its link.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New draft" }));
    await waitFor(() => expect(sent().some((w) => w.method === "POST" && w.path === "/api/nodes")).toBe(true));
    const create = sent().find((w) => w.path === "/api/nodes")!;
    expect(create.body.title).toBe("On “An Article”");
    expect(create.body.parent_id).toBe("reading-notes");
    expect(create.body.markdown).toBe("![[Reading notes/The quick brown fox]]\n\n");
    expect(onOpenNode).toHaveBeenCalledWith(create.body.id);
  });

  it("寫點什麼 › 加到現有筆記… with no quotes appends the title and link", async () => {
    await openArticle();
    await userEvent.click(screen.getByRole("button", { name: /Write something/ }));
    expect(screen.getByText("With the article's title and link.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add to a note…" }));
    const sheet = await screen.findByRole("dialog", { name: "Add to a note…" });
    await userEvent.click(within(sheet).getByRole("option", { name: /Other note/ }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/other")).toBe(true));
    expect(sent().find((w) => w.path === "/api/nodes/other")!.body.markdown).toBe("— [An Article](https://example.com/a) · Daily News\n");
    expect(getAppState().toasts.find((t) => t.action)?.message).toBe("Added to “Other note”.");
  });

  it("excerpts are remembered per article for the session only (nothing stored)", async () => {
    await openArticle();
    select("The quick brown fox");
    await userEvent.click(within(await bar()).getByRole("button", { name: "Put in “Reading notes”" }));
    await waitFor(() => expect(sent().some((w) => w.path === "/api/nodes/reading-notes")).toBe(true));
    expect(JSON.stringify({ ...localStorage })).not.toContain("quick brown fox");
  });
});
