import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { noWorkspaceData, type ContentNode } from "../../lib/api";
import { resetAppState } from "../../lib/appStore";

// The website module's row in the info panel's 「功能」 section
// (FrontendModule.noteFunctionRow): the single publish control — where the note
// stands on the site in words (a note in a space that publishes is on it unless
// kept off), the public link, keeping it off (「不發布」) and putting it back.

const graph = vi.hoisted(() => ({ set: vi.fn(async (_id: string, ..._rest: unknown[]) => true), remove: vi.fn(async () => true) }));
vi.mock("../../lib/data/domainWriters", async (original) => ({ ...await original<typeof import("../../lib/data/domainWriters")>(), propertyWriter: graph }));
// Globals are unstubbed after every test (test/setup.ts): stub per test.
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
const spaceState = vi.hoisted(() => ({ spaces: [] as unknown[] }));
vi.mock("../../lib/spaces", async (original) => ({
  ...await original<typeof import("../../lib/spaces")>(),
  useSpaces: () => ({ spaces: spaceState.spaces, loaded: true }),
  loadedSpaces: () => spaceState.spaces,
}));
vi.mock("../../lib/capabilities", async (original) => ({
  ...await original<typeof import("../../lib/capabilities")>(),
  useCapabilities: () => ({ canMoveInto: () => true, canMoveOut: () => true, canEdit: () => true }),
}));
// GET /api/site/url/:id — the note's address on the served site (D42) — and
// GET /api/site/status/:id — whether the site has it, and current.
const servedUrls = vi.hoisted(() => new Map<string, string | null>());
const siteStates = vi.hoisted(() => ({ state: "not_on_site" as "not_on_site" | "outdated" | "current" }));
const apiCalls = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  api: vi.fn(async (path: string) => {
    if (path.startsWith("/api/site/status/")) { statusCalls.push(path); return { state: siteStates.state }; }
    if (!path.startsWith("/api/site/url/")) return { spaces: [] };
    apiCalls.push(path);
    const id = decodeURIComponent(path.split("/").pop()!);
    return { published_url: servedUrls.get(id) ?? null };
  }),
}));
const statusCalls = vi.hoisted(() => [] as string[]);
// The publish preview and confirmation are the Website screen's own; here only
// that the menu opens them and rereads afterwards.
const publisher = vi.hoisted(() => ({ previewPublish: vi.fn(async () => ({ hash: "h" })), publish: vi.fn(async () => ({ url: "/site/" })), keepSubtreeOff: vi.fn(async (_id: string) => ({ marked: 3, event_id: "e" })) }));
vi.mock("./websiteWriter", async (original) => ({ ...await original<typeof import("./websiteWriter")>(), makeWebsiteWriter: () => publisher }));
vi.mock("./PublishPreviewDialog", () => ({
  default: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>Confirm publish</button>,
}));


const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", ...extra });

function withNodes(nodes: ContentNode[], { owner = false, online = true } = {}) {
  resetAppState({ data: { ...noWorkspaceData, nodes, actor_is_owner: owner }, online });
}

const { default: PublishNoteRow } = await import("./PublishNoteRow");
const { websiteModule } = await import(".");

const marked = (id = "page", extra: Partial<ContentNode> = {}) => note(id, { attrs: { _published: "true" }, ...extra });
const show = async (node: ContentNode, opts: Parameters<typeof withNodes>[1] = {}, nodes: ContentNode[] = [node]) => {
  withNodes(nodes, opts);
  const view = render(<PublishNoteRow node={node} readOnly={false} />);
  await act(async () => {});
  return view;
};

describe("PublishNoteRow", () => {
  beforeEach(() => { vi.clearAllMocks(); servedUrls.clear(); apiCalls.length = 0; statusCalls.length = 0; siteStates.state = "not_on_site"; spaceState.spaces = []; });

  it("a note with words is on the site with no mark at all; 「不發布」 keeps it off", async () => {
    await show(note("page", { markdown: "Words." }), { owner: true });
    expect(screen.getByText("Goes live with the next site publish")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep off the site" }));
    expect(graph.set).toHaveBeenCalledWith("page", "_published", "false", { value_type: "bool", is_inheritable: false });
  });

  // 「不發布這則」 on a note with notes under it (owner 2026-11-14): ask once.
  describe("with notes under it", () => {
    const parent = note("page", { markdown: "Words." });
    const family = [parent, note("kid", { markdown: "Kid.", parent_id: "page" }), note("grand", { markdown: "Grand.", parent_id: "kid" }),
      note("already", { markdown: "Off.", parent_id: "page", attrs: { _published: "false" } }), note("elsewhere", { markdown: "Not under." })];

    it("asks how many notes are under it, and 「一起不發布」 keeps the whole group off in one call", async () => {
      await show(parent, { owner: true }, family);
      fireEvent.click(screen.getByRole("button", { name: "Keep off the site" }));
      expect(screen.getByText("Keep the 2 notes under it off the site too?")).toBeTruthy();
      expect(graph.set).not.toHaveBeenCalled(); // nothing is written before the answer
      fireEvent.click(screen.getByRole("button", { name: "Keep them all off" }));
      await act(async () => {});
      expect(publisher.keepSubtreeOff).toHaveBeenCalledWith("page");
      expect(graph.set).not.toHaveBeenCalled();
      expect(screen.queryByText("Keep the 2 notes under it off the site too?")).toBeNull();
    });

    it("「只有這則」 keeps today's behaviour: only this note is marked", async () => {
      await show(parent, { owner: true }, family);
      fireEvent.click(screen.getByRole("button", { name: "Keep off the site" }));
      fireEvent.click(screen.getByRole("button", { name: "Only this one" }));
      expect(graph.set).toHaveBeenCalledWith("page", "_published", "false", { value_type: "bool", is_inheritable: false });
      expect(publisher.keepSubtreeOff).not.toHaveBeenCalled();
    });

    it("a refused group action keeps the question open", async () => {
      publisher.keepSubtreeOff.mockRejectedValueOnce(new Error("offline"));
      await show(parent, { owner: true }, family);
      fireEvent.click(screen.getByRole("button", { name: "Keep off the site" }));
      fireEvent.click(screen.getByRole("button", { name: "Keep them all off" }));
      await act(async () => {});
      expect(screen.getByText("Keep the 2 notes under it off the site too?")).toBeTruthy();
    });

    it("a note kept off alone says how many notes under it are still on the site", async () => {
      await show(note("page", { markdown: "Words.", attrs: { _published: "false" } }), {}, [
        note("page", { markdown: "Words.", attrs: { _published: "false" } }), note("kid", { markdown: "Kid.", parent_id: "page" })]);
      expect(screen.getByText("1 notes under it are still on the site")).toBeTruthy();
    });

    it("a note with nothing under it is kept off at once, as before", async () => {
      await show(note("page", { markdown: "Words." }), { owner: true });
      fireEvent.click(screen.getByRole("button", { name: "Keep off the site" }));
      expect(screen.queryByText(/under it off the site too/)).toBeNull();
      expect(graph.set).toHaveBeenCalled();
    });
  });

  it("「放回網站」 says the note returns only with the next publish", async () => {
    await show(note("page", { markdown: "Words.", attrs: { _published: "false" } }));
    expect(screen.getByText("Putting it back returns it to the site with your next publish.")).toBeTruthy();
  });

  it("a kept-off note says so and reads nothing; 「放回網站」 takes its 「不發布」 away", async () => {
    await show(note("page", { markdown: "Words.", attrs: { _published: "false" } }));
    expect(screen.getByText("Kept off the site")).toBeTruthy();
    expect(statusCalls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Put back on the site" }));
    expect(graph.remove).toHaveBeenCalledWith("page", "_published");
  });

  it("a note made under a kept-off note says why it is off, and 「放回網站」 puts it on", async () => {
    await show(note("page", { markdown: "Words.", attrs: { _published: "false", _published_by_parent: "true" } }));
    expect(screen.getByText("Off the site by default: the note above it was kept off when this one was made")).toBeTruthy();
    expect(screen.queryByText("Kept off the site")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Put back on the site" }));
    expect(graph.remove).toHaveBeenCalledWith("page", "_published");
  });

  it("a blank note stays off and can be published anyway", async () => {
    await show(note("page"));
    expect(screen.getByText("Blank notes are not put on the site")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish anyway" }));
    expect(graph.set).toHaveBeenCalledWith("page", "_published", "true", { value_type: "bool", is_inheritable: false });
  });

  it("the 功能 tab's 「發布到網站」 is offered for a note the site keeps off, and brings it on", async () => {
    const publish = websiteModule.noteCommands!.find((c) => c.id === "a-publish-note")!;
    expect(publish.row?.related?.(note("page"), "")).toBe(false); // listed under 「還能用在這則」 in the 功能 tab
    const env = { online: true };
    withNodes([]);
    expect(publish.available!(note("page"), "", env)).toBe(true); // blank
    expect(publish.available!(note("page", { markdown: "Words.", attrs: { _published: "false" } }), "", env)).toBe(true);
    expect(publish.available!(note("page", { markdown: "Words." }), "", env)).toBe(false); // already on the site
    expect(publish.available!(marked("page"), "", env)).toBe(false);
    expect(publish.available!(note("page", { hidden: true }), "", env)).toBe(false);
    spaceState.spaces = [{ id: "sp1", kind: "personal", is_default: false, name: "me", capabilities: { publish: false } }];
    expect(publish.available!(note("page", { space_id: "sp1" }), "", env)).toBe(false);
    await publish.run({ node: note("page"), open: vi.fn(), openNode: vi.fn(), refresh: vi.fn() });
    expect(graph.set).toHaveBeenCalledWith("page", "_published", "true", { value_type: "bool", is_inheritable: false });
    await publish.run({ node: note("page", { attrs: { _published: "false" } }), open: vi.fn(), openNode: vi.fn(), refresh: vi.fn() });
    expect(graph.remove).toHaveBeenCalledWith("page", "_published");
  });

  it("a note in a space that does not publish gets no row (nothing about what it cannot do)", async () => {
    const personal = { id: "sp1", kind: "personal", is_default: false, name: "me", capabilities: { publish: false } };
    const everyone = { id: "sp2", kind: "shared", is_default: true, name: "共用", capabilities: { publish: true } };
    spaceState.spaces = [personal, everyone];
    await show(note("page", { space_id: "sp1" }));
    expect(document.querySelector(".info-publish")).toBeNull();
    expect(statusCalls).toEqual([]);
  });

  it("a hidden note gets no row and reads nothing", async () => {
    await show(marked("page", { hidden: true }));
    expect(document.querySelector(".info-publish")).toBeNull();
    expect(apiCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
  });

  it("a marked note the site lacks says it goes live with the next publish; the owner can publish now", async () => {
    siteStates.state = "not_on_site";
    await show(marked(), { owner: true });
    expect(screen.getByText("Goes live with the next site publish")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(apiCalls).toEqual([]); // no address to look up for a note the site doesn't serve
    fireEvent.click(screen.getByRole("button", { name: "Keep off the site" }));
    expect(graph.set).toHaveBeenCalledWith("page", "_published", "false", { value_type: "bool", is_inheritable: false });
  });

  it("without the owner there is no way to publish the site, only to keep the note off", async () => {
    siteStates.state = "outdated";
    await show(marked(), { owner: false });
    expect(screen.getByText("The site has an older version")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep off the site" })).toBeTruthy();
  });

  it("a note on the site with the latest version offers its link, not an update", async () => {
    siteStates.state = "current";
    // The site renamed this note's clashing slug, and the note was renamed after
    // Publish: readers still find it at the snapshot's address.
    const page = marked("p2aaaa-id", { title: "Plan (renamed)", slug: "plan-renamed" });
    servedUrls.set(page.id, "/site/plan-p2aaaa");
    await show(page, { owner: true });
    expect(screen.getByText("On the site")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open page" }).getAttribute("href")).toBe(`${window.location.origin}/site/plan-p2aaaa`);
    expect(apiCalls).toEqual([`/api/site/url/${page.id}`]);
  });

  it("reads nothing and offers no site action offline", async () => {
    siteStates.state = "outdated";
    await show(marked(), { owner: true, online: false });
    expect(statusCalls).toEqual([]);
    expect(screen.getByText("Goes on the site")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish now" })).toBeNull();
  });

  it("opens the shared preview, publishes on confirm, then reads the state again", async () => {
    siteStates.state = "outdated";
    await show(marked(), { owner: true });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    siteStates.state = "current"; // what the server answers once the publish is done
    fireEvent.click(await screen.findByText("Confirm publish"));
    await act(async () => {});
    expect(publisher.previewPublish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ preview_hash: "h" }));
    await act(async () => {});
    expect(statusCalls.length).toBe(2);
    expect(await screen.findByText("On the site")).toBeTruthy();
  });

  it("shows nothing at all when the note can't be edited", async () => {
    const leaf = marked("leaf");
    const { rerender } = await show(leaf);
    expect(document.querySelector(".info-publish")).not.toBeNull();
    rerender(<PublishNoteRow node={leaf} readOnly />);
    expect(document.querySelector(".info-publish")).toBeNull();
  });
});
