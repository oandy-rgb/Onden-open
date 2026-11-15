import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async original => ({
  ...await original<typeof import("../lib/api")>(),
  api: request,
  // postRead calls api inside lib/api, past the mock; forward it to the same spy.
  postRead: (path: string, body: unknown, init: RequestInit = {}) => request(path, { ...init, method: "POST", body: JSON.stringify(body) }),
}));
vi.mock("../lib/localDb", () => ({ flushLocalDbSync: vi.fn() }));
import { noWorkspaceData, type ContentNode, ApiError } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { resetDraftForNode, typeIntoDraft, __resetDraftStateForTests } from "../lib/data/draftActions";
import { snapshotNoteForExport, renderNoteExport, noteExportFilename } from "../lib/noteExport";
import { useNoteExport } from "../hooks/useNoteExport";
import { excerptBlock } from "@onden/markdown";
import { replaceAllAnchors, replaceAllBindings } from "../lib/blockAnchorStore";

const note: ContentNode = { id: "a", title: "中文筆記", slug: "old", markdown: "saved", source_type: "manual", node_type: "content" };
const clipboard = vi.fn();
let click: ReturnType<typeof vi.spyOn>;
const exportRequest = (title: string, markdown: string) =>
  ["/api/nodes/a/export-preview", { method: "POST", body: JSON.stringify({ title, markdown, format: "markdown" }) }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
beforeEach(() => {
  vi.useFakeTimers(); request.mockReset(); clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  vi.stubGlobal("URL", URL);
  URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn();
  click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  __resetDraftStateForTests();
  resetAppState({ data: { ...noWorkspaceData, nodes: [note] }, selectedId: "a", online: true });
});
afterEach(() => { cleanup(); __resetDraftStateForTests(); vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetAppState(); });

it("uses current title/body and keeps an intentionally emptied draft without writing", async () => {
  resetDraftForNode(note); typeIntoDraft("a", { markdown: "", title: "改名 / 程式設計" });
  request.mockResolvedValue({ markdown: "---\ntitle: 改名 / 程式設計\n---\n" });
  const { result } = renderHook(() => useNoteExport(true));
  await act(async () => { expect(await result.current.copyMarkdown()).toBe(true); });
  expect(request).toHaveBeenCalledWith(...exportRequest("改名 / 程式設計", ""));
  expect(clipboard).toHaveBeenCalledWith("---\ntitle: 改名 / 程式設計\n---\n");
  expect(getAppState().saveStatus).toBe("unsaved");
  expect(noteExportFilename("改名 / 程式設計", "md")).toBe("改名 - 程式設計.md");
});

it("the Markdown file asks the server for the chosen way to write paragraph links; the default sends nothing extra", async () => {
  request.mockResolvedValue({ markdown: "file" });
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { await result.current.exportNote("markdown", { partLinks: "obsidian" }); });
  expect(request).toHaveBeenLastCalledWith("/api/nodes/a/export-preview", { method: "POST", body: JSON.stringify({ title: "中文筆記", markdown: "saved", part_links: "obsidian", format: "markdown" }) });
  await act(async () => { await result.current.exportNote("markdown", { partLinks: "footnote" }); });
  expect(request).toHaveBeenLastCalledWith("/api/nodes/a/export-preview", { method: "POST", body: JSON.stringify({ title: "中文筆記", markdown: "saved", part_links: "footnote", format: "markdown" }) });
  await act(async () => { await result.current.exportNote("markdown"); });
  expect(request).toHaveBeenLastCalledWith(...exportRequest("中文筆記", "saved"));
});

it("does not copy an unrelated editor or a hidden stale editor over the current card text", async () => {
  request.mockResolvedValue({ markdown: "file" });
  resetDraftForNode({ ...note, id: "b", markdown: "other draft" });
  const one = renderHook(() => useNoteExport(true));
  await act(async () => { await one.result.current.copyMarkdown(); });
  expect(request).toHaveBeenLastCalledWith(...exportRequest("中文筆記", "saved"));
  resetDraftForNode(note); typeIntoDraft("a", { markdown: "stale invisible editor" });
  setAppState({ data: { ...noWorkspaceData, nodes: [{ ...note, markdown: "new card text" }] } });
  const two = renderHook(() => useNoteExport(false));
  await act(async () => { await two.result.current.copyMarkdown(); });
  expect(request).toHaveBeenLastCalledWith(...exportRequest("中文筆記", "new card text"));
});

it("hydrates slim bodies, retaining the captured local title", async () => {
  request.mockResolvedValue({ ...note, title: "old server title", markdown: "full body", body_len: 9 });
  expect(await snapshotNoteForExport({ ...note, markdown: "", body_len: 9 }, null))
    .toEqual({ id: "a", title: "中文筆記", markdown: "full body" });
});

it.each([new ApiError(403, "forbidden"), new TypeError("offline")])("refuses a missing body instead of downloading an empty file: %s", async error => {
  setAppState({ data: { ...noWorkspaceData, nodes: [{ ...note, markdown: "", body_len: 9 }] } });
  request.mockRejectedValue(error);
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { expect(await result.current.exportNote("markdown")).toBe(false); });
  expect(click).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it.each(["wrong-id", "deleted", "still-slim"])("rejects an unusable body response: %s", async kind => {
  request.mockResolvedValue({ ...note, ...(kind === "wrong-id" ? { id: "b" } : kind === "deleted" ? { deleted_at: "now" } : { markdown: "", body_len: 9 }) });
  await expect(snapshotNoteForExport({ ...note, markdown: "", body_len: 9 }, null)).rejects.toThrow("unavailable");
});

it("starts the clipboard write within the gesture with the pending server file; only confirms after acceptance", async () => {
  const file = deferred<{ markdown: string }>(); request.mockReturnValue(file.promise);
  const write = deferred<void>(); const items: Array<Record<string, Promise<Blob>>> = [];
  vi.stubGlobal("ClipboardItem", class { constructor(item: Record<string, Promise<Blob>>) { items.push(item); } });
  const clipboardWrite = vi.fn(() => write.promise);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard, write: clipboardWrite } });
  const { result } = renderHook(() => useNoteExport(false));
  let operation!: Promise<boolean>;
  act(() => { operation = result.current.copyMarkdown(); expect(clipboardWrite).toHaveBeenCalledOnce(); });
  await act(async () => { file.resolve({ markdown: "![](/api/media/a.png)" }); });
  expect(await (await items[0]["text/plain"]).text()).toBe(`![](${new URL("/api/media/a.png", location.origin).href})`);
  expect(getAppState().toasts).toHaveLength(0); expect(clipboard).not.toHaveBeenCalled();
  await act(async () => { write.resolve(); expect(await operation).toBe(true); });
  expect(getAppState().toasts.at(-1)?.message).toBe("Copied");
});

it.each(["denied", "unavailable"])("reports clipboard %s without claiming success", async reason => {
  request.mockResolvedValue({ markdown: "file" });
  if (reason === "denied") clipboard.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { expect(await result.current.copyMarkdown()).toBe(false); });
  expect(getAppState().toasts.map(t => t.message)).toEqual(["Could not copy. Download Markdown from the note menu instead."]);
});

it("downloads the server's exported file, media made absolute, with a safe Unicode filename", async () => {
  request.mockResolvedValue({ markdown: "---\ntitle: 中文筆記\ntags: [book]\n---\n![](/api/media/ab12.png) [x](https://h/api/media/b.pdf)\n" });
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { expect(await result.current.exportNote("markdown")).toBe(true); });
  expect(request).toHaveBeenCalledWith(...exportRequest("中文筆記", "saved"));
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
  const media = (file: string) => new URL(`/api/media/${file}`, location.origin).href;
  expect(await blob.text()).toBe(`---\ntitle: 中文筆記\ntags: [book]\n---\n![](${media("ab12.png")}) [x](${media("b.pdf")})\n`);
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("中文筆記.md");
});

it("downloads nothing when the server cannot write the file (offline)", async () => {
  request.mockRejectedValue(new TypeError("offline"));
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { expect(await result.current.exportNote("markdown")).toBe(false); });
  expect(click).not.toHaveBeenCalled(); expect(getAppState().toasts).toHaveLength(1);
});

it.each(["switch", "gate", "unmount"])("cancels late output after %s, including A → B → A", async change => {
  const body = deferred<ContentNode>(); request.mockReturnValue(body.promise);
  setAppState({ data: { ...noWorkspaceData, nodes: [{ ...note, markdown: "", body_len: 9 }] } });
  const { result, unmount } = renderHook(() => useNoteExport(false));
  let operation!: Promise<boolean>;
  act(() => { operation = result.current.exportNote("markdown"); });
  act(() => {
    if (change === "switch") { setAppState({ selectedId: "b" }); setAppState({ selectedId: "a" }); }
    else if (change === "gate") { setAppState({ membershipGated: true }); setAppState({ membershipGated: false }); }
    else unmount();
  });
  await act(async () => { body.resolve(note); expect(await operation).toBe(false); });
  expect(click).not.toHaveBeenCalled(); expect(getAppState().toasts).toHaveLength(0);
});

it("converts the captured draft as a read-only request and resolves media references", async () => {
  request.mockResolvedValue({ html: '<!doctype html><html><head></head><body><img src="/api/media/中文.png"><a href="#part">part</a></body></html>' });
  const html = await renderNoteExport({ id: "a", title: "新標題", markdown: "new" });
  expect(request).toHaveBeenCalledWith("/api/nodes/a/export-preview", { method: "POST", body: JSON.stringify({ title: "新標題", markdown: "new" }) });
  expect(html).toContain(new URL("/api/media/中文.png", location.origin).href); expect(html).toContain('href="#part"');
});

it("keeps the export snapshot even if typing continues while rendering", async () => {
  const html = deferred<{ html: string }>(); request.mockReturnValue(html.promise);
  resetDraftForNode(note); typeIntoDraft("a", { markdown: "first draft" });
  const { result } = renderHook(() => useNoteExport(true));
  let operation!: Promise<boolean>;
  act(() => { operation = result.current.exportNote("html"); });
  expect(JSON.parse(request.mock.calls[0][1].body).markdown).toBe("first draft");
  typeIntoDraft("a", { markdown: "next draft" });
  await act(async () => { html.resolve({ html: "<!doctype html><html><body>first draft</body></html>" }); expect(await operation).toBe(true); });
  expect(getAppState().overviewDraft).toBe("next draft"); expect(click).toHaveBeenCalledOnce();
});

it("does not turn server failures or malformed HTML into downloads", async () => {
  request.mockResolvedValue({ html: "login page" });
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { expect(await result.current.exportNote("html")).toBe(false); });
  request.mockRejectedValue(new ApiError(503, "down"));
  await act(async () => { expect(await result.current.exportNote("html")).toBe(false); });
  expect(click).not.toHaveBeenCalled();
});

it("reports blocked print windows before requesting content", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { expect(await result.current.exportNote("pdf")).toBe(false); });
  expect(request).not.toHaveBeenCalled();
  expect(getAppState().toasts.at(-1)?.message).toBe("Allow pop-ups to print this note to PDF");
});

it("opens print output during the gesture, prints only after load, and never claims a PDF download", async () => {
  let load!: () => void;
  const popup = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn(), title: "" },
    opener: window, closed: false, close: vi.fn(), focus: vi.fn(), print: vi.fn(),
    addEventListener: vi.fn((_event: string, listener: () => void) => { load = listener; }) };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  const html = deferred<{ html: string }>(); request.mockReturnValue(html.promise);
  const { result } = renderHook(() => useNoteExport(false));
  let operation!: Promise<boolean>;
  act(() => { operation = result.current.exportNote("pdf"); expect(open).toHaveBeenCalledOnce(); });
  expect(popup.print).not.toHaveBeenCalled();
  await act(async () => { html.resolve({ html: "<!doctype html><html><body>saved</body></html>" }); expect(await operation).toBe(true); });
  expect(popup.document.write).toHaveBeenCalled(); expect(popup.opener).toBeNull();
  expect(popup.print).not.toHaveBeenCalled(); load(); expect(popup.print).toHaveBeenCalledOnce();
  expect(click).not.toHaveBeenCalled(); expect(getAppState().toasts).toHaveLength(0);
});

it("closes the empty print window on a conversion failure", async () => {
  const popup = { document: { title: "" }, close: vi.fn(), opener: window };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  request.mockRejectedValue(new ApiError(404, "Not Found"));
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { expect(await result.current.exportNote("pdf")).toBe(false); });
  expect(popup.close).toHaveBeenCalledOnce();
  expect(getAppState().toasts.at(-1)?.message).toBe("HTML conversion is unavailable. Download Markdown for now.");
});

it("writes an embedded excerpt out as its quote and source link; other embeds stay as written", async () => {
  const source = { title: "An Article", url: "https://example.com/a", feed: "Daily News" };
  const excerpt = excerptBlock({ exact: "The quick brown fox", prefix: "See" }, source);
  const today = { ...note, id: "t", title: "2026-10-29", markdown: `${excerpt}\n\nPlain\n` };
  // The quote is anchor k1 and "Plain" is anchor p1: the old-form embeds below name them by anchor id.
  const held = (id: string, from: number, to: number) => ({ anchor_id: id, note_id: "t", from, to, status: "valid" as const, candidate_from: null, candidate_to: null, quote: today.markdown.slice(from, to) });
  replaceAllAnchors([held("k1", 0, excerpt.length), held("p1", excerpt.length + 2, excerpt.length + 7)]);
  const mine = { ...note, markdown: "My thoughts\n\n![[2026-10-29#^k1]]\n\n![[2026-10-29#^p1]]\n\n![[Missing#^k1]]\n" };
  setAppState({ data: { ...noWorkspaceData, nodes: [mine, today] } });
  request.mockResolvedValue({ markdown: "file" });
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { await result.current.copyMarkdown(); });
  const sent = JSON.parse(request.mock.calls.at(-1)![1].body) as { markdown: string };
  expect(sent.markdown).toBe(
    "My thoughts\n\n> The quick brown fox\n>\n> — [An Article](https://example.com/a#:~:text=See-,The%20quick%20brown%20fox) · Daily News\n\n![[2026-10-29#^p1]]\n\n![[Missing#^k1]]\n",
  );
});

it("writes an excerpt embedded by a part link (`![[筆記/開頭]]`, bound or typed by hand) out as its quote and source link", async () => {
  const source = { title: "An Article", url: "https://example.com/a", feed: "Daily News" };
  const excerpt = excerptBlock({ exact: "The quick brown fox", prefix: "See" }, source);
  const today = { ...note, id: "t", title: "2026-10-29", markdown: `${excerpt}\n\nPlain words here\n` };
  const held = (id: string, from: number, to: number) => ({ anchor_id: id, note_id: "t", from, to, status: "valid" as const, candidate_from: null, candidate_to: null, quote: today.markdown.slice(from, to) });
  replaceAllAnchors([held("k1", 0, excerpt.length), held("p1", excerpt.length + 2, excerpt.length + 2 + "Plain words here".length)]);
  // `![[2026-10-29/The quick brown fox]]` is bound to k1 (the sync brought the binding); the second is typed by hand, with no binding;
  // a part that is not an excerpt and an embed inside a sentence stay.
  replaceAllBindings([{ note_id: "a", link_text: "2026-10-29/The quick brown fox", anchor_id: "k1" }]);
  const mine = { ...note, markdown: "![[2026-10-29/The quick brown fox]]\n\n![[2026-10-29/Plain words]]\n\nsee ![[2026-10-29/The quick brown fox]] here\n" };
  setAppState({ data: { ...noWorkspaceData, nodes: [mine, today] } });
  request.mockResolvedValue({ markdown: "file" });
  const { result } = renderHook(() => useNoteExport(false));
  await act(async () => { await result.current.copyMarkdown(); });
  const sent = JSON.parse(request.mock.calls.at(-1)![1].body) as { markdown: string };
  const quote = "> The quick brown fox\n>\n> — [An Article](https://example.com/a#:~:text=See-,The%20quick%20brown%20fox) · Daily News";
  expect(sent.markdown).toBe(`${quote}\n\n![[2026-10-29/Plain words]]\n\nsee ![[2026-10-29/The quick brown fox]] here\n`);
});
