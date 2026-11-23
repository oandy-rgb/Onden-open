// The ＋ flow: the box opens straight away (keyboard up), asks no question about
// kind or place, shows where the text will go as one line, and sends to the
// inbox unless the account's setting — or a pick for this one capture — says
// otherwise. Words in the text may name a #tag or a [[note.
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
import { QuickCapture, openQuickCapture } from "../modules/capture";
import { captureDestinationPref } from "../modules/capture/captureDestination";
import { bindAccountStorage } from "../lib/accountStorage";
import type { ContentNode, Tag } from "../lib/api";
import { createKindsFor } from "../lib/createKinds";
import { reads } from "../lib/data";
import { resetAppState } from "../lib/appStore";
import { PREFS, removePref } from "../lib/prefs";
import { INBOX_TAG_ID, captureProps, type CaptureProps } from "./helpers/captureProps";
import { knowPersonalSpace } from "./helpers/knownSpaces";

const note = (id: string, title: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, slug: id, markdown: "", source_type: "manual", node_type: "content", ...extra });
const NOTES = [note("n-reading", "Reading list"), note("n-ds", "Data structures")];
const SCHOOL = { id: "t-school", name: "school", parent_id: null } as unknown as Tag;

const posts = () => sendOrQueue.mock.calls.filter(([m, p]) => m === "POST" && p === "/api/nodes")
  .map(([, , body]) => JSON.parse(body as string) as { id: string; title: string; markdown: string; parent_id?: string | null; tag_ids?: string[]; attributes?: Array<{ key: string; value: string }> });

function renderClosed(over: Partial<CaptureProps> = {}) {
  const props = captureProps({ nodes: NOTES, ...over });
  render(<QuickCapture {...props} />);
  act(() => openQuickCapture());
  return props;
}
const typeAndSend = async (text: string) => {
  // Pasted, not typed: user-event reads "[" as the start of a key name.
  await userEvent.click(await screen.findByRole("textbox"));
  await userEvent.paste(text);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
};

beforeAll(async () => {
  bindAccountStorage("flow-user", "https://onden.example/");
  // The box loads on the first request to open it; load it once here so no test pays for the import.
  await import("../modules/capture/QuickCapture");
});
beforeEach(async () => {
  await knowPersonalSpace(); // today's diary is the home of a task with no note
  resetAppState();
  localStorage.clear();
  removePref(PREFS.quickCaptureDraft);
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  captureDestinationPref.store.save(null);
  vi.restoreAllMocks();
});

describe("opening the box", () => {
  it("shows the text box with the keyboard up and asks about neither kind nor place", async () => {
    renderClosed();
    const box = await screen.findByRole("textbox");
    expect(box).toHaveFocus();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Goes to: Inbox" })).toBeInTheDocument();
  });

  it("is closed until something opens it", () => {
    render(<QuickCapture {...captureProps()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("sending", () => {
  it("with no setting goes to the inbox as a top-level note, and the box clears for the next one", async () => {
    renderClosed();
    await typeAndSend("buy milk");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      markdown: "buy milk", parent_id: null, tag_ids: [INBOX_TAG_ID], attributes: [{ key: "_captured", value: "true" }],
    });
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(screen.getByRole("status")).toHaveTextContent("Saved to Inbox");
    await typeAndSend("another");
    await waitFor(() => expect(posts()).toHaveLength(2));
  });

  it("goes under the note the account's setting names", async () => {
    captureDestinationPref.store.save("n-reading");
    renderClosed();
    expect(await screen.findByRole("button", { name: "Goes to: Reading list" })).toBeInTheDocument();
    await typeAndSend("chapter 3 is good");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ parent_id: "n-reading" });
    expect(posts()[0]!.tag_ids).toBeUndefined();
  });

  it("does not follow the note that is open or the last note chosen: the setting is the only default", async () => {
    renderClosed();
    await typeAndSend("one");
    await waitFor(() => expect(posts()).toHaveLength(1));
    await typeAndSend("two");
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map((p) => p.parent_id)).toEqual([null, null]);
  });

  it("a pick on the line above the box is for this capture only", async () => {
    renderClosed();
    await userEvent.click(await screen.findByRole("button", { name: "Goes to: Inbox" }));
    const picker = await screen.findByRole("combobox");
    await userEvent.type(picker, "Reading");
    await userEvent.click(await screen.findByRole("option", { name: /Reading list/ }));
    expect(await screen.findByRole("button", { name: "Goes to: Reading list" })).toBeInTheDocument();
    await typeAndSend("read it");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ parent_id: "n-reading" });
    // Back to the setting, which was never touched.
    await waitFor(() => expect(screen.getByRole("button", { name: "Goes to: Inbox" })).toBeInTheDocument());
    expect(captureDestinationPref.store.get().value).toBeNull();
  });

  it("the picker's top row is the inbox", async () => {
    captureDestinationPref.store.save("n-reading");
    renderClosed();
    await userEvent.click(await screen.findByRole("button", { name: "Goes to: Reading list" }));
    await userEvent.click(await screen.findByRole("option", { name: "Inbox" }));
    expect(screen.getByRole("button", { name: "Goes to: Inbox" })).toBeInTheDocument();
  });
});

describe("what the words say", () => {
  it("applies a #tag that exists in the same request, and leaves one that does not as text", async () => {
    renderClosed({ tags: [captureProps().tags[0]!, SCHOOL] });
    await typeAndSend("exam notes #school #nosuchtag");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ markdown: "exam notes #school #nosuchtag", tag_ids: [INBOX_TAG_ID, "t-school"] });
  });

  it("[[note files the capture under that note, without the token", async () => {
    vi.spyOn(reads.notes, "search").mockResolvedValue({
      rows: [{ id: "n-ds", title: "Data structures", node_type: "content", snippet: null }], offline: false, fieldFilterSkipped: false,
    });
    renderClosed();
    await typeAndSend("AVL trees rotate [[Data structures");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ markdown: "AVL trees rotate", parent_id: "n-ds" });
    expect(posts()[0]!.tag_ids).toBeUndefined();
    expect(screen.getByRole("status")).toHaveTextContent("Saved to Data structures");
  });

  it("a [[note that is not found stays text and the capture goes where it would", async () => {
    vi.spyOn(reads.notes, "search").mockResolvedValue({ rows: [], offline: false, fieldFilterSkipped: false });
    renderClosed();
    await typeAndSend("see [[Nothing like it]] later");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ markdown: "see [[Nothing like it]] later", parent_id: null, tag_ids: [INBOX_TAG_ID] });
  });

  it("a day word makes a task and says so before it is sent", async () => {
    renderClosed();
    await userEvent.type(await screen.findByRole("textbox"), "call dentist tomorrow");
    expect(screen.getByText("Will be saved as a task: call dentist")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sendOrQueue.mock.calls.some(([m, p]) => m === "POST" && p === "/api/tasks")).toBe(true));
    expect(posts()).toHaveLength(1); // today's diary, which the task is written into
    expect(screen.getByRole("status")).toHaveTextContent("Saved as a task");
  });
});

describe("other kinds and 「更多…」", () => {
  it("handwriting, a file and a bookmark are small icons that create through the shared entry, then file like a capture", async () => {
    const create = vi.fn(async () => "made-1");
    renderClosed({ create, kinds: createKindsFor(() => true) });
    const kindButtons = within(await screen.findByRole("dialog")).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(kindButtons).toEqual(expect.arrayContaining(["Handwriting", "Upload a file", "Bookmark"]));
    expect(kindButtons).not.toContain("Note");
    await userEvent.click(screen.getByRole("button", { name: "Handwriting" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("ink", { parentId: null }));
    await waitFor(() => expect(sendOrQueue.mock.calls.some(([m, p]) => m === "PUT" && p === `/api/nodes/made-1/tags/${INBOX_TAG_ID}`)).toBe(true));
  });

  it("under a chosen note the new note goes under it and is not put in the inbox", async () => {
    captureDestinationPref.store.save("n-reading");
    const create = vi.fn(async () => "made-2");
    renderClosed({ create, kinds: createKindsFor(() => true) });
    await userEvent.click(await screen.findByRole("button", { name: "Bookmark" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("bookmark", { parentId: "n-reading" }));
    expect(sendOrQueue.mock.calls.some(([, p]) => String(p).includes("/tags/"))).toBe(false);
  });

  it("「更多…」 hands over to the full create sheet and keeps the draft", async () => {
    const props = renderClosed();
    await userEvent.type(await screen.findByRole("textbox"), "half a thought");
    await userEvent.click(screen.getByRole("button", { name: "More…" }));
    expect(props.onMore).toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    act(() => openQuickCapture());
    expect(await screen.findByRole("textbox")).toHaveValue("half a thought");
  });
});
