// QuickCapture must not be online-only: a thought captured offline has to be
// persisted to the app's write-queue and replayed on reconnect, never dropped.
// These tests pin (1) the Save path goes through the queued write path, not a
// raw fetch, (2) the button + ⌘↵ stay enabled offline, and (3) the captured
// note is in the store and local mirror at once, so it can be listed offline
// (GAP-185). The one thing offline cannot do is make the inbox's tag the very
// first time: the text is kept and the person is told.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Every write lands in `sendOrQueue(method, path, body)`: the note writer's
// creates (submitWrite) and the tag/date extras (sendOrQueue). Resolving
// undefined behaves like the queued (offline) branch.
const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
const mirror = vi.hoisted(() => ({ upserted: [] as string[] }));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  upsertNode: async (node: { id: string }) => { mirror.upserted.push(node.id); },
  removeNode: async () => {},
}));

import QuickCapture from "../modules/capture/QuickCapture";
import { captureDestinationPref } from "../modules/capture/captureDestination";
import { bindAccountStorage } from "../lib/accountStorage";
import { ApiError, type ContentNode } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";
import { reads } from "../lib/data";
import { refreshSpaces, resetSpacesForTest } from "../lib/spaces";
import { INBOX_TAG_ID, captureProps, type CaptureProps } from "./helpers/captureProps";

function renderCapture(overrides: Partial<CaptureProps> = {}) {
  const props = captureProps({ initialDraft: "hello offline world", ...overrides });
  render(<QuickCapture {...props} />);
  return props;
}
const posts = () => sendOrQueue.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/nodes")
  .map(([, , body]) => JSON.parse(body as string) as { id: string; markdown: string; parent_id: string | null; tag_ids?: string[]; attributes?: Array<{ key: string; value: string }> });

describe("QuickCapture offline-safe save", () => {
  beforeAll(() => { bindAccountStorage("offline-user", "https://onden.example/"); });
  beforeEach(() => {
    resetAppState();
    localStorage.clear();
    sendOrQueue.mockReset();
    mirror.upserted.length = 0;
    // Default: behave like the queued (offline) branch — no server node back.
    sendOrQueue.mockResolvedValue(undefined);
    captureDestinationPref.store.save(null);
  });

  it("keeps refused input and explains permission denial through the shared error message", async () => {
    sendOrQueue.mockRejectedValueOnce(new ApiError(403, "role 'viewer' is below required 'editor'"));
    renderCapture();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("textbox")).toHaveValue("hello offline world");
    expect(getAppState().toasts).toEqual([expect.objectContaining({ message: "You don't have permission to do that." })]);
  });

  it("routes the capture through the write queue (not a raw fetch), in the inbox", async () => {
    renderCapture({ online: false });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).not.toBeDisabled(); // <- the offline gate is gone

    await userEvent.click(save);

    expect(sendOrQueue).toHaveBeenCalledTimes(1);
    const [method, path] = sendOrQueue.mock.calls[0]!;
    expect([method, path]).toEqual(["POST", "/api/nodes"]);
    expect(posts()[0]).toMatchObject({ markdown: "hello offline world", parent_id: null, tag_ids: [INBOX_TAG_ID], attributes: [{ key: "_captured", value: "true" }] });
  });

  it("keeps the Save button enabled while offline", () => {
    renderCapture({ online: false });
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    // Offline hint reassures (queued), no longer a dead-end "reconnect to save".
    expect(screen.queryByText(/reconnect to save/i)).toBeNull();
  });

  it("⌘↵ commits a capture while offline", async () => {
    renderCapture({ online: false });
    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    await waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
  });

  it("without the inbox's tag yet, offline keeps the text and says why", async () => {
    renderCapture({ online: false, tags: [] });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("hello offline world");
    expect(getAppState().toasts).toEqual([expect.objectContaining({ message: "Connect once to set up the inbox. Your text is kept." })]);
  });

  it("mints today's day node through the write queue when the setting is today's journal", async () => {
    captureDestinationPref.store.save("today");
    renderCapture({ online: false });
    expect(screen.getByRole("button", { name: /Goes to: Today's journal/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // Two POSTs: the day node (parent) + the captured child.
    expect(sendOrQueue).toHaveBeenCalledTimes(2);
    const dayBody = JSON.parse(sendOrQueue.mock.calls[0]![2] as string) as { id: string };
    const childBody = JSON.parse(sendOrQueue.mock.calls[1]![2] as string) as { parent_id: string; tag_ids?: string[] };
    // The child references the offline-created day node by its client-minted id, and is not in the inbox.
    expect(childBody.parent_id).toBe(dayBody.id);
    expect(childBody.tag_ids).toBeUndefined();
  });

  it("a setting that names a tag reads as the inbox (D101: a note can't go under a tag)", async () => {
    const tag = { id: "tag-1", title: "讀書", node_type: "class_tag" } as ContentNode;
    captureDestinationPref.store.save("tag-1");
    renderCapture({ online: false, nodes: [tag] });
    expect(screen.getByRole("button", { name: /Goes to: Inbox/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ parent_id: null, tag_ids: [INBOX_TAG_ID] });
  });

  it("a setting that names a note this person only reads reads as the inbox (D101: 403 on replay)", async () => {
    resetSpacesForTest();
    vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces: [
      { id: "lab", name: "Lab", kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "view", can_manage: false },
    ] } as never);
    try {
      await refreshSpaces();
      const readOnly = { id: "lab-note", title: "Lab notes", node_type: "content", space_id: "lab" } as ContentNode;
      captureDestinationPref.store.save("lab-note");
      renderCapture({ online: false, nodes: [readOnly] });
      expect(screen.getByRole("button", { name: /Goes to: Inbox/ })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(posts()[0]).toMatchObject({ parent_id: null, tag_ids: [INBOX_TAG_ID] });
    } finally {
      vi.restoreAllMocks();
      resetSpacesForTest();
    }
  });

  it("an offline capture is in the store and local mirror before any server reply (GAP-185)", async () => {
    renderCapture({ online: false });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const id = posts()[0]!.id;
    const node = getAppState().data.nodes.find((n) => n.id === id);
    expect(node).toMatchObject({ markdown: "hello offline world", parent_id: null });
    expect(mirror.upserted).toContain(id);
  });

  it("a refused capture leaves no note behind", async () => {
    sendOrQueue.mockRejectedValueOnce(new ApiError(403, "role 'viewer' is below required 'editor'"));
    renderCapture();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(getAppState().data.nodes).toHaveLength(0);
  });
});
