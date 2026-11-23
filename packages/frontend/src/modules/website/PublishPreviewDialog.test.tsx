// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "../../test/helpers/offlineNetwork";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PublishPreviewDialog from "./PublishPreviewDialog";
import type { PendingPublish } from "./publishPreview";
import type { PublishPreview } from "@onden/contract";
import { noWorkspaceData, type ContentNode } from "../../lib/api";
import { resetAppState } from "../../lib/appStore";
import { hintsSeenStore } from "../../lib/hintsSeenStore";
import { dictionariesReady, setLocalePref } from "../../lib/i18n";
import type { Space } from "../../lib/spaces";

// The confirmation before a publish shows the candidate itself: what changes
// against the last publish, links that will read "(private)", images readers
// won't get — and confirming is the only way to publish.
vi.mock("./studio/PublishedHomePreview", () => ({
  default: ({ site }: { site: { payload: { nodes?: Array<{ title: string }> } } }) => <div data-testid="site">{(site.payload.nodes ?? []).map((n) => n.title).join(",")}</div>,
}));
const putOnSiteSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./putOnSite", () => ({ putOnSite: putOnSiteSpy }));
const spaceState = vi.hoisted(() => ({ spaces: [] as unknown[] }));
const spaceApiMock = vi.hoisted(() => ({
  previewMove: vi.fn(), move: vi.fn(),
}));
vi.mock("../../lib/spaces", async (original) => ({
  ...(await original<typeof import("../../lib/spaces")>()),
  useSpaces: () => ({ spaces: spaceState.spaces, loaded: true }),
  refreshSpaces: async () => {},
  spaceApi: { ...(await original<typeof import("../../lib/spaces")>()).spaceApi, ...spaceApiMock },
}));
vi.mock("../../lib/capabilities", async (original) => ({
  ...(await original<typeof import("../../lib/capabilities")>()),
  useCapabilities: () => ({ canMoveInto: () => true, canMoveOut: () => true, canEdit: () => true }),
}));

const base: PublishPreview = {
  hash: "h".repeat(64),
  site: { id: null, event_cursor: 0, artifact_ref: "a", created_at: "2026-10-14T08:00:00.000Z", title: "Site", home_node_id: "n1", payload: { nodes: [{ id: "n1", title: "Home", slug: "home" }, { id: "n2", title: "Notes", slug: "notes" }] } },
  live: { snapshot_id: "s1", published_at: "2026-10-14T08:00:00.000Z" },
  diff: {
    added: [{ id: "n2", title: "Notes", slug: "notes" }],
    returning: [],
    changed: [{ id: "n1", title: "Home", slug: "home" }],
    moved: [],
    links_changed: [],
    removed: [{ id: "n3", title: "Old", slug: "old", taken_down: true }],
    settings_changed: false,
  },
  private_links: [{ node_id: "n1", node_title: "Home", target: "Secret", shown_as: "(private)" }],
  blocked_media: [
    { filename: "a.png", reason: "not_public", node_ids: ["n1"] },
    { filename: "b.png", reason: "missing", node_ids: [] },
  ],
  new_media: [], large_videos: [], unpublished_refs: [], diagrams_needed: [],
  // Absent on purpose: an older server sends no `left_out`, and the dialog then works the list out itself (the tests below).
  left_out: undefined as unknown as PublishPreview["left_out"],
};
const nothing: PublishPreview["diff"] = { added: [], returning: [], changed: [], moved: [], links_changed: [], removed: [], settings_changed: false };
const pending = (preview: PublishPreview = base): PendingPublish => ({ body: { title: "Site", home_node_id: "n1", presentation: {} }, preview });
beforeEach(() => { hintsSeenStore.save(null); setLocalePref("en"); spaceState.spaces = []; resetAppState({ data: { ...noWorkspaceData, nodes: [] }, online: true }); });
afterEach(() => { cleanup(); resetAppState(); });

describe("publish preview dialog", () => {
  it("lists the changes, private links and blocked images", () => {
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("New on the site (1)")).toBeInTheDocument();
    expect(screen.getByText("Changed (1)")).toBeInTheDocument();
    expect(screen.getByText("Leaving the site (1)")).toBeInTheDocument();
    expect(screen.getByText(/already hidden from readers/)).toBeInTheDocument();
    expect(screen.getByText("In “Home”: [[Secret]] reads “(private)”")).toBeInTheDocument();
    expect(screen.getByText("a.png: it belongs to a private note")).toBeInTheDocument();
    expect(screen.getByText("b.png: the file is missing on the server")).toBeInTheDocument();
  });

  it("keeps what the site shows apart from what this publish changes, so 'nothing changed' does not sit over a long list", () => {
    render(<PublishPreviewDialog online publishing={false} onConfirm={() => {}} onCancel={() => {}}
      pending={pending({ ...base, diff: { ...nothing } })} />);
    const group = screen.getByRole("group", { name: "What readers will and won't see" });
    expect(screen.getByText("Nothing has changed since the last publish.").closest("[role=group]")).toBeNull();
    expect(within(group).getByText("This is the same as last time. It is about what the site shows, not about this publish.")).toBeInTheDocument();
    expect(within(group).getByText(/Links to private notes/)).toBeInTheDocument();
    expect(within(group).getByText(/Images readers won't see/)).toBeInTheDocument();
  });

  it("the buttons stay outside the part that scrolls", () => {
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    const body = document.querySelector(".publish-review-body")!;
    expect(body).toContainElement(screen.getByText("New on the site (1)"));
    for (const name of ["See the site", "Cancel", "Confirm & publish →"]) expect(body).not.toContainElement(screen.getByRole("button", { name }));
  });

  it("after a publish that did not go out, the same button offers another try", async () => {
    const onConfirm = vi.fn(async () => false);
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm & publish →" }));
    expect(await screen.findByRole("button", { name: "Try publishing again →" })).toBeEnabled();
  });

  it("a private link reads in the app's language", async () => {
    setLocalePref("zh-TW");
    await dictionariesReady();
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(document.body.textContent).toContain("顯示成「（私人）」");
    expect(document.body.textContent).not.toContain("(private)");
  });

  it("lists the files that become public, a logo and an icon in plain words and no file names", () => {
    const withNew: PublishPreview = {
      ...base,
      new_media: [
        { filename: "1111.png", used_as: "logo", node_ids: [] },
        { filename: "2222.png", used_as: "favicon", node_ids: [] },
        { filename: "3333.png", used_as: "other", node_ids: ["n1"] },
      ],
    };
    render(<PublishPreviewDialog pending={pending(withNew)} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Newly public files (3)")).toBeInTheDocument();
    expect(screen.getByText("The site logo")).toBeInTheDocument();
    expect(screen.getByText("The site icon")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/1111|2222|3333/);
  });

  it("says when nothing changed, and an empty site can't be published", () => {
    const { rerender } = render(<PublishPreviewDialog online publishing={false} onConfirm={() => {}} onCancel={() => {}}
      pending={pending({ ...base, diff: { ...nothing }, private_links: [], blocked_media: [] })} />);
    expect(screen.getByText("Nothing has changed since the last publish.")).toBeInTheDocument();
    rerender(<PublishPreviewDialog online publishing={false} onConfirm={() => {}} onCancel={() => {}}
      pending={pending({ ...base, live: null, site: { ...base.site, payload: { nodes: [] } } })} />);
    expect(screen.getByRole("button", { name: "Confirm & publish →" })).toBeDisabled();
  });

  it("lists notes taken off earlier as coming back with this publish (owner 2026-11-14)", () => {
    const back = { id: "n9", title: "Returning note", slug: "returning" };
    render(<PublishPreviewDialog online publishing={false} onConfirm={() => {}} onCancel={() => {}}
      pending={pending({ ...base, diff: { ...nothing, returning: [back] }, private_links: [], blocked_media: [] })} />);
    expect(screen.queryByText("Nothing has changed since the last publish.")).not.toBeInTheDocument();
    expect(screen.getByText("Coming back to the site (1)")).toBeInTheDocument();
    expect(screen.getByText("Returning note")).toBeInTheDocument();
  });

  it("lists a reorder and a link change: they change the site's nav and Related (D80)", () => {
    const home = { id: "n1", title: "Home", slug: "home" };
    render(<PublishPreviewDialog online publishing={false} onConfirm={() => {}} onCancel={() => {}}
      pending={pending({ ...base, diff: { ...nothing, moved: [home], links_changed: [home] }, private_links: [], blocked_media: [] })} />);
    expect(screen.queryByText("Nothing has changed since the last publish.")).not.toBeInTheDocument();
    expect(screen.getByText("Moved (1)")).toBeInTheDocument();
    expect(screen.getByText("Links changed (1)")).toBeInTheDocument();
  });

  it("shows the candidate site, and only Confirm publishes", async () => {
    const onConfirm = vi.fn();
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "See the site" }));
    // The home page of the candidate is a lazy chunk (the app page does not load it).
    expect(await screen.findByTestId("site")).toHaveTextContent("Home,Notes");
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & publish →" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("home-page notes that are not published are listed, with 「一起發布」 (offered only when the caller can act on it)", () => {
    const preview = { ...base, unpublished_refs: [{ componentId: "c1", noteId: "d1", title: "Draft" }, { componentId: "c2", noteId: "d1", title: "Draft" }] };
    const onInclude = vi.fn();
    const { rerender } = render(<PublishPreviewDialog pending={pending(preview)} publishing={false} online onConfirm={() => {}} onCancel={() => {}} onInclude={onInclude} />);
    expect(screen.getByText("On the home page but not published (2)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish together" }));
    expect(onInclude).toHaveBeenCalledWith(["d1"]);
    rerender(<PublishPreviewDialog pending={pending(preview)} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("button", { name: "Publish together" })).toBeNull();
  });

  it("an empty candidate says why: no space publishes, or what the notes are kept out by", () => {
    const empty = pending({ ...base, live: null, site: { ...base.site, payload: { nodes: [] } } });
    const { rerender } = render(<PublishPreviewDialog pending={empty} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/No space publishes yet/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/inspector/i);

    const personal = { id: "sp1", kind: "personal", is_default: false, name: "me", capabilities: { publish: false } } as unknown as Space;
    spaceState.spaces = [personal];
    const secret = { id: "s1", title: "Private plan", slug: "p", markdown: "", node_type: "content", source_type: "manual", space_id: "sp1", attrs: { _published: "true" } } as ContentNode;
    resetAppState({ data: { ...noWorkspaceData, nodes: [secret] }, online: true });
    rerender(<PublishPreviewDialog pending={empty} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/every note that could go on it is left out/)).toBeInTheDocument();
    const section = screen.getByText("Marked for the site but left out (1)").closest("section")!;
    expect(within(section).getByText(/Private plan/)).toBeInTheDocument();
    expect(within(section).getByText(/which does not publish/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm & publish →" })).toBeDisabled();
  });

  it("a note left out is explained even when the site is not empty", () => {
    const personal = { id: "sp1", kind: "personal", is_default: false, name: "me", capabilities: { publish: false } } as unknown as Space;
    spaceState.spaces = [personal];
    const secret = { id: "s1", title: "Private plan", slug: "p", markdown: "", node_type: "content", source_type: "manual", space_id: "sp1", attrs: { _published: "true" } } as ContentNode;
    resetAppState({ data: { ...noWorkspaceData, nodes: [secret] }, online: true });
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Marked for the site but left out (1)")).toBeInTheDocument();
  });

  describe("marked notes the server says the site leaves out", () => {
    const everyone = { id: "sp-all", kind: "shared", is_default: true, name: "共用", capabilities: { publish: true } } as unknown as Space;
    const emptyWith = (left_out: PublishPreview["left_out"]) =>
      pending({ ...base, live: null, site: { ...base.site, payload: { nodes: [] } }, left_out });
    const mine = { node_id: "a", title: "My page", reason: "space_not_published" as const, space: { id: "sp1", kind: "personal" as const, is_default: false, name: "me" } };

    it("names the note, the space in plain words and the way out, without asking 'is anything marked'", () => {
      spaceState.spaces = [everyone];
      render(<PublishPreviewDialog pending={emptyWith([mine])} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
      expect(screen.getByText(/every note that could go on it is left out/)).toBeInTheDocument();
      expect(screen.queryByText(/No space publishes yet/)).toBeNull();
      expect(screen.getByText(/My page/)).toBeInTheDocument();
      expect(screen.getByText(/“Only me”, which does not publish/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Move to “Everyone”" })).toBeInTheDocument();
    });

    it("moves only after the owner confirms who gains access, then asks for a fresh preview", async () => {
      spaceState.spaces = [everyone];
      spaceApiMock.previewMove.mockResolvedValue({ node_id: "a", from: {}, to: {}, notes: 1, lose: [], membership_epoch: 7, gain: [{ id: "p1", name: "Mei", type: "human" }] });
      spaceApiMock.move.mockResolvedValue({ moved: 1 });
      const onChanged = vi.fn();
      render(<PublishPreviewDialog pending={emptyWith([mine])} publishing={false} online onConfirm={() => {}} onCancel={() => {}} onChanged={onChanged} />);
      fireEvent.click(screen.getByRole("button", { name: "Move to “Everyone”" }));
      expect(await screen.findByText(/These people will be able to see them: Mei/)).toBeInTheDocument();
      expect(spaceApiMock.move).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Move" }));
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(spaceApiMock.move).toHaveBeenCalledWith("a", "sp-all", 7);
    });

    it("a hidden note says it is hidden and offers no move", () => {
      spaceState.spaces = [everyone];
      render(<PublishPreviewDialog pending={emptyWith([{ node_id: "h", title: "", reason: "hidden", space: null }])} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
      expect(screen.getByText(/hidden notes are not published/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Move to/ })).toBeNull();
    });

    it("notes a publishing space keeps off are listed folded, each with its reason, not as a warning", () => {
      spaceState.spaces = [everyone];
      const space = { id: "sp-all", kind: "shared" as const, is_default: true, name: "共用" };
      render(<PublishPreviewDialog pending={pending({ ...base, left_out: [
        { node_id: "k", title: "Draft", reason: "kept_off", space },
        { node_id: "b", title: "Kmap", reason: "blank", space },
        { node_id: "r", title: "Someone's post", reason: "saved_article", space },
      ] })} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
      const details = screen.getByText("3 notes in publishing spaces stay off the site").closest("details")!;
      expect(within(details).getByText(/Draft/).textContent).toContain("set to stay off the site");
      expect(within(details).getByText(/Kmap/).textContent).toContain("blank");
      expect(within(details).getByText(/Someone's post/).textContent).toContain("saved from a feed");
      expect(screen.queryByText(/Marked for the site but left out/)).toBeNull();
    });

    it("a note kept off only because the note above it was says so, and 「放回網站」 puts it on and asks for a fresh preview", async () => {
      spaceState.spaces = [everyone];
      const space = { id: "sp-all", kind: "shared" as const, is_default: true, name: "共用" };
      const onChanged = vi.fn();
      render(<PublishPreviewDialog pending={pending({ ...base, left_out: [
        { node_id: "k", title: "Draft", reason: "kept_off", space },
        { node_id: "c", title: "Child", reason: "kept_off_by_parent", space },
      ] })} publishing={false} online onConfirm={() => {}} onCancel={() => {}} onChanged={onChanged} />);
      const details = screen.getByText("2 notes in publishing spaces stay off the site").closest("details")!;
      expect(within(details).getByText(/Child/).textContent).toContain("made under a note kept off the site, so it starts off too");
      expect(within(details).getByText(/Draft/).textContent).not.toContain("starts off too");
      // Only the inherited one has the button: the other was the person's own choice.
      const putBack = within(details).getAllByRole("button", { name: "Put back on the site" });
      expect(putBack).toHaveLength(1);
      fireEvent.click(putBack[0]!);
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(putOnSiteSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
    });

    it("asks the server again only after the write went through, and not when it failed", async () => {
      spaceState.spaces = [everyone];
      const space = { id: "sp-all", kind: "shared" as const, is_default: true, name: "共用" };
      const onChanged = vi.fn();
      let finish!: (ok: boolean) => void;
      putOnSiteSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
      render(<PublishPreviewDialog pending={pending({ ...base, left_out: [{ node_id: "c", title: "Child", reason: "kept_off_by_parent", space }] })}
        publishing={false} online onConfirm={() => {}} onCancel={() => {}} onChanged={onChanged} />);
      fireEvent.click(screen.getByRole("button", { name: "Put back on the site" }));
      await act(async () => { await Promise.resolve(); });
      expect(onChanged).not.toHaveBeenCalled(); // the write has not gone out yet
      await act(async () => { finish(false); });
      expect(onChanged).not.toHaveBeenCalled(); // it failed: the list stays as the server last said
      putOnSiteSpy.mockImplementationOnce(async () => true);
      fireEvent.click(screen.getByRole("button", { name: "Put back on the site" }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });
  });
});

describe("the first publish after publishing went by space", () => {
  const RULE = /Every note in a space that publishes goes on the site/;
  const withNote = (attrs?: Record<string, string>) => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [{ id: "n2", title: "Notes", attrs } as unknown as ContentNode] }, online: true });
  };

  it("says once that notes nobody marked now go on, and not again after that publish went out", async () => {
    withNote();
    const onConfirm = vi.fn(async () => true);
    const first = render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={onConfirm} onCancel={() => {}} />);
    expect(screen.getByText(RULE)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/_published|snake|JSON/);
    fireEvent.click(screen.getByRole("button", { name: /Confirm & publish/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(hintsSeenStore.get().value).toContain("publish-by-space-rule"));
    first.unmount();
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(RULE)).toBeNull();
  });

  it("a publish that did not go out (stale preview, no network) does not use the hint up", async () => {
    withNote();
    const onConfirm = vi.fn(async () => false);
    const first = render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm & publish/ }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(RULE)).toBeInTheDocument();
  });

  it("stays out of the way when every added note was marked 「發布」 by hand, and when nothing is added", () => {
    withNote({ _published: "true" });
    const marked = render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(RULE)).toBeNull();
    marked.unmount();
    withNote();
    render(<PublishPreviewDialog pending={pending({ ...base, diff: nothing })} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(RULE)).toBeNull();
  });

  it("cancelling does not use the hint up", () => {
    withNote();
    const onCancel = vi.fn();
    const first = render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    first.unmount();
    render(<PublishPreviewDialog pending={pending()} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(RULE)).toBeInTheDocument();
  });

  it("a reason this device does not know reads as a plain phrase, never the raw key", () => {
    const space = { id: "sp", kind: "shared" as const, is_default: true, name: "共用" };
    const future = { node_id: "f", title: "Odd one", reason: "needs_review" as unknown as "blank", space };
    render(<PublishPreviewDialog pending={pending({ ...base, left_out: [future] })} publishing={false} online onConfirm={() => {}} onCancel={() => {}} />);
    const text = screen.getByText(/Odd one/).textContent ?? "";
    expect(text).toContain("left off the site");
    expect(text).not.toMatch(/needs_review|saved from a feed/);
  });
});
