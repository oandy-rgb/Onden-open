// A capture never creates a second note: a retry reuses the same ids. A #word
// that names no tag stays text: capture never makes a tag. A dated line is a
// task, and a refused task keeps the text for a retry.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Every write lands in `sendOrQueue(method, path, body)`: the note writer's
// creates (submitWrite) and the date extra (sendOrQueue). Resolving
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
const resolvePath = vi.fn();
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: (path: string, init?: RequestInit) => resolvePath(path, init),
}));

import QuickCapture from "../modules/capture/QuickCapture";
import { ApiError } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";
import { INBOX_TAG_ID, captureProps } from "./helpers/captureProps";

function renderCapture(draft: string) {
  render(<QuickCapture {...captureProps()} initialDraft={draft} />);
}
const posts = () => sendOrQueue.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/nodes")
  .map(([, , body]) => JSON.parse(body as string) as { id: string; markdown: string; parent_id?: string | null; tag_ids?: string[] });
const taskPosts = () => sendOrQueue.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/tasks")
  .map(([, , body]) => JSON.parse(body as string) as { title: string; when_date?: string; into?: { note_id: string } });

beforeEach(() => {
  resetAppState();
  localStorage.clear();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  resolvePath.mockReset().mockResolvedValue({ leaf_id: "tag-1" });
});

describe("QuickCapture destination", () => {
  it("stays open after a send, and the next capture goes where the setting says, not under the note just made", async () => {
    renderCapture("first");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await userEvent.type(screen.getByRole("textbox"), "second");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map((p) => [p.parent_id, p.tag_ids])).toEqual([[null, [INBOX_TAG_ID]], [null, [INBOX_TAG_ID]]]);
  });
});

describe("QuickCapture failure handling", () => {
  it("keeps a #word that names no tag as typed and resolves, creates or applies no tag", async () => {
    renderCapture("Buy milk #errands #a/b");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].markdown).toBe("Buy milk #errands #a/b");
    // Only the inbox's own tag.
    expect(posts()[0].tag_ids).toEqual([INBOX_TAG_ID]);
    // (The only read is the spaces list, for what this person may edit.)
    expect(resolvePath.mock.calls.filter(([path]) => path !== "/api/spaces")).toEqual([]);
    expect(sendOrQueue.mock.calls.some(([, path]) => String(path).includes("/tags"))).toBe(false);
  });

  it("a day word in one line makes a task, not a note", async () => {
    renderCapture("Call dentist tomorrow");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(taskPosts()).toHaveLength(1));
    expect(taskPosts()[0]).toMatchObject({ title: "Call dentist" });
    expect(taskPosts()[0]!.when_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    // The only note made is today's diary, which the task is written into: no capture note.
    expect(posts()).toHaveLength(1);
    expect(taskPosts()[0]).toMatchObject({ into: { note_id: posts()[0]!.id } });
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
  });

  it("a refused task keeps the text for a retry", async () => {
    sendOrQueue.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/api/tasks") throw new ApiError(422, JSON.stringify({ error: "bad date" }));
      return undefined;
    });
    renderCapture("Call dentist tomorrow");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(getAppState().toasts.some((toast) => toast.kind === "error")).toBe(true));
    expect(screen.getByRole("textbox")).toHaveValue("Call dentist tomorrow");
    expect(posts().filter((post) => post.markdown !== "")).toHaveLength(0); // no capture note (today's diary is empty)
  });

  it("a refused create keeps the text, and the retry reuses the same note id", async () => {
    sendOrQueue.mockRejectedValueOnce(new ApiError(503, "unavailable")).mockResolvedValue(undefined);
    renderCapture("Same thought");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Same thought"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].id).toBe(posts()[0].id);
  });
});
