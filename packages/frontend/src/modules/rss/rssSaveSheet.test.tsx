import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 存下來 → 「存到」: the sheet opens pre-filled with the feed's default (its
// tags and parent note); one tap on 存 keeps the default (the request carries
// no destination, so the server files it at the default); changing the
// destination sends it; the parent picker offers notes only, never tags.

const { apiMock, sendOrQueueMock } = vi.hoisted(() => ({ apiMock: vi.fn(), sendOrQueueMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/data", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/data")>();
  return { ...mod, sendOrQueue: sendOrQueueMock, sendWrite: vi.fn(async () => ({})) };
});

import RssReaderPanel from "./RssReaderPanel";
import { noWorkspaceData, type ContentNode, type Tag } from "../../lib/api";
import { resetAppState } from "../../lib/appStore";

const tag = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id, color: "", schema_id: null }) as Tag;
const note = (id: string, title: string, node_type = "content"): ContentNode =>
  ({ id, title, slug: id, markdown: "", node_type, source_type: "manual" }) as ContentNode;

const source = {
  id: "s1", title: "Daily News", url: "https://example.com/feed.xml", fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 1, created_at: "2026-10-01T00:00:00Z",
  save_default: { tag_ids: ["t-news"], parent_id: "n-reading", parent_title: "Reading", origin: "source" },
};
const item = {
  id: "i1", title: "A long story", source_id: "s1", url: "https://example.com/1", published_at: "2026-10-17T00:00:00Z",
  fetched_at: "2026-10-17T00:00:00Z", seen: false, saved_node_id: null, excerpt: "", image: null,
};

beforeEach(() => {
  resetAppState({
    data: { ...noWorkspaceData,
      tags: [tag("t-news", "新聞"), tag("t-tech", "科技", "t-news"), tag("t-misc", "雜記")],
      nodes: [note("n-reading", "Reading"), note("n-projects", "Projects"), note("t-misc", "雜記", "class_tag")] },
    online: true,
  });
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources: [source], total_unseen: 1, module_default: { tag_ids: ["t-misc"], parent_id: null } };
    if (path.startsWith("/api/rss/items/i1")) return { ...item, body: "<p>" + "Full text. ".repeat(200) + "</p>" };
    if (path.startsWith("/api/rss/items")) return { items: [item], next_cursor: null };
    return {};
  });
  sendOrQueueMock.mockReset();
  sendOrQueueMock.mockImplementation(async (_m: string, _p: string, body: string) => ({ node_id: JSON.parse(body).node_id }));
});

async function openSheet() {
  render(<RssReaderPanel online onOpenNode={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /A long story/ }));
  // The ▾ beside the title (the end of the article has the same control).
  await userEvent.click((await screen.findAllByRole("button", { name: "Choose where to save" }))[0]!);
  return screen.findByRole("dialog", { name: "Save to" });
}
const saveBody = () => JSON.parse(String(sendOrQueueMock.mock.calls.find((c) => String(c[1]).endsWith("/save"))![2]));

describe("RSS save sheet", () => {
  it("opens with the feed's default pre-filled; one tap on 存 keeps it", async () => {
    const sheet = await openSheet();
    expect(within(sheet).getByText("#新聞")).toBeInTheDocument();
    expect(within(sheet).getByText("Reading")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Save it" }));
    await waitFor(() => expect(sendOrQueueMock).toHaveBeenCalled());
    const body = saveBody();
    expect(body.destination).toBeUndefined(); // the server files it at the default
    expect(body.node_id).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("changing the destination sends it: a quick tag, another parent note", async () => {
    const sheet = await openSheet();
    // Quick tags: the module default's folder.
    await userEvent.click(within(sheet).getByRole("button", { name: "+ #雜記" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Choose a note…" }));
    // The shared ParentPicker; notes only: the tag node titled 雜記 is not offered.
    const results = within(sheet).getByRole("listbox", { name: "Parent notes" });
    expect(within(results).queryByRole("option", { name: "雜記" })).toBeNull();
    await userEvent.type(within(sheet).getByRole("combobox", { name: "Search parent notes…" }), "Pro");
    await userEvent.click(within(results).getByRole("option", { name: "Projects" }));
    expect(within(sheet).getByText(/Only this article goes here/)).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Save it" }));
    await waitFor(() => expect(sendOrQueueMock).toHaveBeenCalled());
    expect(saveBody().destination).toEqual({ tag_ids: ["t-news", "t-misc"], parent_id: "n-projects" });
  });

  it("adds a tag by typing (path shown), removes one, and can go top level", async () => {
    const sheet = await openSheet();
    await userEvent.type(within(sheet).getByRole("combobox", { name: "Add a tag" }), "科");
    await userEvent.click(within(sheet).getByRole("option", { name: "#新聞/科技" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove #新聞" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Top level" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Save it" }));
    await waitFor(() => expect(sendOrQueueMock).toHaveBeenCalled());
    expect(saveBody().destination).toEqual({ tag_ids: ["t-tech"], parent_id: null });
  });

  it("a failed save keeps the sheet and the choice", async () => {
    sendOrQueueMock.mockRejectedValue(new Error("parent note not found"));
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Top level" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Save it" }));
    await waitFor(() => expect(sendOrQueueMock).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "Save to" })).toBeInTheDocument();
    expect(within(sheet).getByText("Top level (no parent note)")).toBeInTheDocument();
  });
});
