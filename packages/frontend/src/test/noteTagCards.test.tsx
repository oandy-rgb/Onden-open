vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}),
}));
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import NoteTagCards from "../components/NoteTagCards";
import NoteMetaLine from "../components/NoteMetaLine";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

// A tag's card (path, parent, functions, fields) opens under the title when its
// chip is clicked, at every width; a field shared by several tags shows once, in
// the first card that defines it. The right panel's cards are InfoTagsTab's
// (infoPanel.test.tsx).

const bookRoot: Tag = { id: "t-book", name: "書", color: "#a55", schema_id: null };
const genre: Tag = { id: "t-genre", name: "genre", color: "#55a", schema_id: "s-genre",
  schema_behaviour: { modules: { skills: { enabled: true } } } };
const novel: Tag = {
  id: "t-novel", name: "小說", color: "#a55", schema_id: "s-novel", parent_id: "t-book",
  schema_extends: ["t-genre"], effective_modules: ["skills"],
  // As migration 166 leaves it: the skills reference came from #genre's settings.
  functions: [{ id: "skills", source_tag_id: "t-genre", ref_id: "r1" }],
  schema_fields: [
    { name: "status", label: "Status", type: "select", options: ["reading", "done"] },
    { name: "author", label: "Author", type: "text" },
  ],
};
const meeting: Tag = { id: "t-meeting", name: "meeting", color: "#5a5", schema_id: "s-meeting",
  schema_fields: [{ name: "status", label: "Status", type: "select", options: ["reading", "done"] }, { name: "room", label: "Room", type: "text" }] };
const tags = [bookRoot, genre, novel, meeting];
const note: ContentNode = { id: "n1", title: "Dune", slug: "dune", markdown: "", node_type: "content", source_type: "manual",
  class_tag_ids: ["t-novel", "t-meeting"] };

function mockAttributes() {
  global.fetch = vi.fn(async (url: string) => {
    const own = url.includes("/attributes") && !url.includes("inherited") && !url.includes("rollup");
    const body = own ? [
      { key: "status", value: "reading", value_type: "text", is_inheritable: false, source: "explicit" },
      { key: "isbn", value: "978-0441013593", value_type: "text", is_inheritable: false, source: "explicit" },
    ] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

function setPhone(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query.includes("max-width"), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(async () => { await import("../components/NoteTagCards"); });
beforeEach(() => {
  mockAttributes();
  resetAppState({ data: { ...noWorkspaceData, nodes: [note], tags }, online: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetAppState();
  act(() => setLocalePref("system"));
  // jsdom has no matchMedia: put that back.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function cards(extra: Partial<React.ComponentProps<typeof NoteTagCards>> = {}) {
  const onOpenTag = vi.fn();
  render(<>
    <NoteTagCards node={note} canEdit onOpenTag={onOpenTag} show={{ tagId: "t-novel" }} {...extra} />
    <NoteTagCards node={note} canEdit onOpenTag={onOpenTag} show={{ tagId: "t-meeting" }} {...extra} />
  </>);
  return onOpenTag;
}

describe("tag cards", () => {
  it("a tag's card has its path, parent and functions; a shared field shows once", async () => {
    const onOpenTag = cards();
    await waitFor(() => expect(screen.getByRole("button", { name: "reading", pressed: true })).toBeInTheDocument());

    const novelCard = screen.getByRole("region", { name: "#小說" });
    fireEvent.click(within(novelCard).getByRole("button", { name: "#書/小說" }));
    expect(onOpenTag).toHaveBeenCalledWith("t-novel");
    // 上層 is the hierarchy; the extends of #genre is not called inheritance.
    expect(novelCard).toHaveTextContent("Parent #書");
    fireEvent.click(within(novelCard).getByRole("button", { name: "#書" }));
    expect(onOpenTag).toHaveBeenCalledWith("t-book");
    expect(novelCard).not.toHaveTextContent(/inherit/i);
    // What the tag brings, with the function it gets by extending #genre.
    expect(novelCard).toHaveTextContent(/Notes with this tag get: Skills \(through #genre\)/);
    expect(novelCard).toHaveTextContent("1 note");
    // Status is the novel's and the meeting's: one value, in the first card.
    expect(within(novelCard).getByText(/Status/)).toBeInTheDocument();
    expect(within(novelCard).getByText("also used by #meeting")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "reading", pressed: true })).toHaveLength(1);

    const meetingCard = screen.getByRole("region", { name: "#meeting" });
    expect(within(meetingCard).getByText(/Room/)).toBeInTheDocument();
    expect(within(meetingCard).queryByText(/Status/)).toBeNull();
    // A tag's card is that tag only: no "Other properties", no "+ Tag".
    expect(screen.queryByRole("region", { name: "Other properties" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Add a )?[Tt]ag$/ })).toBeNull();
  });

  it("a field the tag inherits (tagFields) is in its card, marked where it comes from", async () => {
    const inheriting: Tag = { ...novel, effective_fields: [
      ...(novel.schema_fields ?? []),
      { name: "isbn", label: "ISBN", type: "text", inherited_from: "t-genre" },
    ] };
    resetAppState({ data: { ...noWorkspaceData, nodes: [note], tags: [bookRoot, genre, inheriting, meeting] }, online: true });
    render(<NoteTagCards node={note} canEdit onOpenTag={() => {}} show={{ tagId: "t-novel" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "reading", pressed: true })).toBeInTheDocument());
    const novelCard = screen.getByRole("region", { name: "#小說" });
    expect(within(novelCard).getByText(/ISBN/)).toBeInTheDocument();
    expect(within(novelCard).getByText("from #genre")).toBeInTheDocument();
    // Its value is the tag's field now, shown in the card.
    expect(await within(novelCard).findByDisplayValue("978-0441013593")).toBeInTheDocument();
  });

  it("read-only: fields as text, no add field", async () => {
    cards({ canEdit: false });
    await waitFor(() => expect(screen.getByText("reading")).toBeInTheDocument());
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByPlaceholderText("name")).toBeNull();
  });

  it("a module tag the tag extends shows as a function, never as inheritance", async () => {
    const reviewTag: Tag = { id: "t-review", name: "技能", color: "", schema_id: "s-review", schema_module: "skills", effective_modules: ["skills"] };
    const course: Tag = { id: "t-course", name: "課程", color: "", schema_id: "s-course", schema_extends: ["t-review"], effective_modules: ["skills"] };
    resetAppState({ data: { ...noWorkspaceData, nodes: [note], tags: [reviewTag, course] }, online: true });
    act(() => setLocalePref("zh-TW"));
    render(<NoteTagCards node={{ ...note, class_tag_ids: ["t-course"] }} canEdit onOpenTag={() => {}} show={{ tagId: "t-course" }} />);
    const card = await screen.findByRole("region", { name: "#課程" });
    expect(card).toHaveTextContent("有這個標籤的筆記會多出：技能");
    expect(card).not.toHaveTextContent("繼承");
    expect(card).not.toHaveTextContent("上層");
  });
});

describe("tag cards: values here, structure on the tag page", () => {
  it("the owner gets 「編輯 #X 的欄位 →」 on each card, which opens the tag page's fields", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [note], tags, actor_is_owner: true }, online: true });
    const onOpenTag = vi.fn();
    act(() => setLocalePref("zh-TW"));
    render(<>
      <NoteTagCards node={note} canEdit onOpenTag={onOpenTag} show={{ tagId: "t-novel" }} />
      <NoteTagCards node={note} canEdit onOpenTag={onOpenTag} show={{ tagId: "t-meeting" }} />
    </>);
    const novelCard = await screen.findByRole("region", { name: "#小說" });
    fireEvent.click(within(novelCard).getByRole("button", { name: "編輯 #小說 的欄位 →" }));
    expect(onOpenTag).toHaveBeenCalledWith("t-novel");
    const { takeTagFieldsRequest } = await import("../lib/tagPageRequest");
    expect(takeTagFieldsRequest("t-novel")).toBe(true);
    expect(within(screen.getByRole("region", { name: "#meeting" })).getByRole("button", { name: "編輯 #meeting 的欄位 →" })).toBeInTheDocument();
    // The owner may add an option to a select field inline.
    await waitFor(() => expect(screen.getByRole("button", { name: "＋ 新增選項…" })).toBeInTheDocument());
  });

  it("a non-owner editor sees no way to change a tag's structure", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [note], tags, actor_is_owner: false }, online: true });
    render(<NoteTagCards node={note} canEdit onOpenTag={() => {}} show={{ tagId: "t-novel" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "reading", pressed: true })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Edit the fields of/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New option/ })).toBeNull();
    expect(screen.queryByText(/↗/)).toBeNull();
    // Values stay editable.
    expect(screen.getByRole("button", { name: "reading", pressed: true })).toBeInTheDocument();
  });
});

describe("the grey line under the title (tags in it, the same at every width)", () => {
  const onePhone = [true, false];
  for (const phone of onePhone) {
    describe(phone ? "phone" : "wide screen", () => {
      beforeEach(() => setPhone(phone));

      it("has the chips and one '＋', and no separate Tags toggle", () => {
        render(<NoteMetaLine online node={note} tags={tags} canEdit onOpenTag={() => {}} />);
        expect(screen.getByRole("button", { name: "#小說" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "#meeting" })).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Add a tag" })).toHaveLength(1);
        expect(screen.queryByRole("button", { name: /^Tags/ })).toBeNull();
        expect(screen.queryByRole("region", { name: "#小說" })).toBeNull();
      });

      it("a chip opens its card below the row; again closes; another chip switches", async () => {
        render(<NoteMetaLine online node={note} tags={tags} canEdit onOpenTag={() => {}} />);
        const novelChip = screen.getByRole("button", { name: "#小說" });
        const meetingChip = screen.getByRole("button", { name: "#meeting" });
        fireEvent.click(novelChip);
        expect(novelChip).toHaveAttribute("aria-expanded", "true");
        const card = await screen.findByRole("region", { name: "#小說" });
        expect(novelChip).toHaveAttribute("aria-controls", card.closest(".note-meta-cards")!.id);
        expect(screen.queryByRole("region", { name: "#meeting" })).toBeNull();
        // Only that tag's card: not Other properties, not the other tag.
        expect(screen.queryByRole("region", { name: "Other properties" })).toBeNull();

        fireEvent.click(meetingChip);
        expect(await screen.findByRole("region", { name: "#meeting" })).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "#小說" })).toBeNull();
        expect(novelChip).toHaveAttribute("aria-expanded", "false");
        expect(meetingChip).toHaveAttribute("aria-expanded", "true");

        fireEvent.click(meetingChip);
        expect(meetingChip).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("region", { name: "#meeting" })).toBeNull();
      });

      it("the chip no longer opens the tag page; a link inside the card does", async () => {
        const onOpenTag = vi.fn();
        render(<NoteMetaLine online node={note} tags={tags} canEdit onOpenTag={onOpenTag} />);
        fireEvent.click(screen.getByRole("button", { name: "#小說" }));
        expect(onOpenTag).not.toHaveBeenCalled();
        const card = await screen.findByRole("region", { name: "#小說" });
        fireEvent.click(within(card).getByRole("button", { name: "#書/小說" }));
        expect(onOpenTag).toHaveBeenCalledWith("t-novel");
      });

      it("another note opens with the card closed; a removed tag closes its card", async () => {
        const { rerender } = render(<NoteMetaLine online node={note} tags={tags} canEdit onOpenTag={() => {}} />);
        fireEvent.click(screen.getByRole("button", { name: "#小說" }));
        await screen.findByRole("region", { name: "#小說" });
        rerender(<NoteMetaLine online node={{ ...note, id: "n2" }} tags={tags} canEdit onOpenTag={() => {}} />);
        expect(screen.queryByRole("region", { name: "#小說" })).toBeNull();
        rerender(<NoteMetaLine online node={note} tags={tags} canEdit onOpenTag={() => {}} />);
        expect(screen.queryByRole("region", { name: "#小說" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "#小說" }));
        await screen.findByRole("region", { name: "#小說" });
        rerender(<NoteMetaLine online node={{ ...note, class_tag_ids: ["t-meeting"] }} tags={tags} canEdit onOpenTag={() => {}} />);
        expect(screen.queryByRole("region", { name: "#小說" })).toBeNull();
      });

      it("read-only: chips still open a card (values as text), no '＋'", async () => {
        render(<NoteMetaLine online node={note} tags={tags} canEdit={false} onOpenTag={() => {}} />);
        expect(screen.queryByRole("button", { name: /^(Add a )?[Tt]ag$/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "#小說" }));
        const card = await screen.findByRole("region", { name: "#小說" });
        await waitFor(() => expect(within(card).getByText("reading")).toBeInTheDocument());
      });
    });
  }
});
