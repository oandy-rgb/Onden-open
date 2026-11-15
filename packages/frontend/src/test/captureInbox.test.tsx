// The inbox page: captures nobody has filed, newest first. Moving one under a note
// files it (it leaves the inbox, its creation time and capture flag stay); it can
// also be tagged, turned into a task, or deleted.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  upsertNode: async () => {},
  removeNode: async () => {},
}));

import "../modules";
import InboxScreen from "../modules/capture/InboxScreen";
import CaptureNavIndicator from "../modules/capture/CaptureNavIndicator";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { getAppState, resetAppState, setBootstrapped, setData } from "../lib/appStore";
import { INBOX_TAG, INBOX_TAG_ID } from "./helpers/captureProps";

const note = (id: string, title: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, slug: id, markdown: title, source_type: "manual", node_type: "content", ...extra });
const captured = (id: string, title: string, at: string) =>
  note(id, title, { class_tag_ids: [INBOX_TAG_ID], created_at: at, attrs: { _captured: "true" } });

const NODES = [
  captured("old", "Older thought", "2026-10-28T08:00:00Z"),
  captured("new", "Newest thought", "2026-10-29T09:00:00Z"),
  note("plain", "A plain note", { created_at: "2026-10-29T10:00:00Z" }),
  note("n-reading", "Reading list"),
];
const SCHOOL = { id: "t-school", name: "school", parent_id: null } as unknown as Tag;

const screenProps = { online: true, target: null, onOpenNode: vi.fn(), onRefresh: vi.fn(), onImmersiveChange: vi.fn() };
const load = (nodes: ContentNode[] = NODES, tags: Tag[] = [INBOX_TAG, SCHOOL]) =>
  act(() => { setData(() => ({ ...noWorkspaceData, nodes, tags })); setBootstrapped(true); });
const titles = () => [...document.querySelectorAll(".capture-inbox-item-title")].map((el) => el.textContent);
const writes = () => sendOrQueue.mock.calls.map(([m, p]) => `${m} ${p}`);

beforeAll(() => { bindAccountStorage("inbox-user", "https://onden.example/"); });
beforeEach(() => {
  resetAppState();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
});

describe("the inbox page", () => {
  it("lists only the unfiled captures, newest first, with words and no ids", async () => {
    await load();
    render(<InboxScreen {...screenProps} />);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(titles()).toEqual(["Newest thought", "Older thought"]);
    expect(screen.queryByText("A plain note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/inbox-tag|\bnew\b.*\bold\b/);
  });

  it("under the phone's 收件匣 tab it leaves out its own title (the tab names it)", async () => {
    await load();
    render(<InboxScreen {...screenProps} inTab />);
    expect(screen.queryByRole("heading", { name: "Inbox" })).toBeNull();
    expect(screen.getByRole("region", { name: "Inbox" })).toBeInTheDocument();
    expect(titles()).toEqual(["Newest thought", "Older thought"]);
  });

  it("an empty inbox says so and offers to write", async () => {
    await load([note("n-reading", "Reading list")]);
    render(<InboxScreen {...screenProps} />);
    expect(screen.getByText("Nothing waiting. What you jot down without a place lands here.")).toBeInTheDocument();
    const opened = vi.fn();
    window.addEventListener("onden-open-quick-capture", opened);
    await userEvent.click(screen.getByRole("button", { name: "Quick capture" }));
    window.removeEventListener("onden-open-quick-capture", opened);
    expect(opened).toHaveBeenCalled();
  });

  it("opens a capture in the editor", async () => {
    await load();
    const onOpenNode = vi.fn();
    render(<InboxScreen {...screenProps} onOpenNode={onOpenNode} />);
    await userEvent.click(screen.getByText("Newest thought"));
    expect(onOpenNode).toHaveBeenCalledWith("new");
  });

  it("moving one under a note files it: it moves, loses the inbox tag, and leaves the list", async () => {
    await load();
    render(<InboxScreen {...screenProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Move “Newest thought” to…" }));
    await userEvent.click(await screen.findByRole("option", { name: /Reading list/ }));
    await waitFor(() => expect(titles()).toEqual(["Older thought"]));
    expect(writes()).toEqual(expect.arrayContaining(["PATCH /api/nodes/new", `DELETE /api/nodes/new/tags/${INBOX_TAG_ID}`]));
    const moved = getAppState().data.nodes.find((n) => n.id === "new")!;
    expect(moved).toMatchObject({ parent_id: "n-reading", created_at: "2026-10-29T09:00:00Z", attrs: { _captured: "true" } });
    expect(moved.class_tag_ids).toEqual([]);
  });

  it("makes a task on the capture's note, then files it", async () => {
    await load([captured("new", "call dentist tomorrow", "2026-10-29T09:00:00Z")]);
    render(<InboxScreen {...screenProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Make “call dentist tomorrow” a task" }));
    await waitFor(() => expect(writes()).toContain("POST /api/nodes/new/tasks"));
    const body = JSON.parse(sendOrQueue.mock.calls.find(([, p]) => p === "/api/nodes/new/tasks")![2] as string) as { title: string; when_date?: string };
    expect(body.title).toBe("call dentist");
    expect(body.when_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    await waitFor(() => expect(writes()).toContain(`DELETE /api/nodes/new/tags/${INBOX_TAG_ID}`));
  });

  it("adds a tag without filing the capture", async () => {
    await load();
    render(<InboxScreen {...screenProps} />);
    const row = screen.getByText("Newest thought").closest("li")!;
    // The inbox's own tag is not shown as a chip on the row.
    expect(within(row).queryByText("#收件匣")).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Tag" }));
    await userEvent.type(within(row).getByRole("combobox", { name: "Add a tag" }), "sch");
    await userEvent.click(await screen.findByRole("option", { name: /school/ }));
    await waitFor(() => expect(writes()).toContain("PUT /api/nodes/new/tags/t-school"));
    expect(writes().some((w) => w.startsWith("DELETE") && w.includes("/tags/"))).toBe(false);
    expect(titles()).toEqual(["Newest thought", "Older thought"]);
  });

  it("deletes a capture", async () => {
    await load();
    render(<InboxScreen {...screenProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete “Older thought”" }));
    await waitFor(() => expect(writes()).toContain("DELETE /api/nodes/old"));
  });
});

describe("the mark on the inbox entry", () => {
  it("counts the waiting captures, as a dot where the entry is folded, and is absent when empty", async () => {
    await load();
    const count = render(<CaptureNavIndicator />);
    expect(within(count.container).getByLabelText("2 waiting in the inbox")).toHaveTextContent("2");
    count.unmount();
    const dot = render(<CaptureNavIndicator dotOnly />);
    expect(within(dot.container).getByRole("img", { name: "Waiting in the inbox" })).toBeInTheDocument();
    dot.unmount();
    await load([note("n-reading", "Reading list")]);
    const none = render(<CaptureNavIndicator />);
    expect(none.container).toBeEmptyDOMElement();
  });
});
