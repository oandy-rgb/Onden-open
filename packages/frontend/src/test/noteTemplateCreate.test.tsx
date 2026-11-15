// "New from template" with a tag that stamps its own scaffold (D69): the
// Meeting pack's tag creates Agenda / Decisions / Action items as child notes
// when applied (server templateExpander), so the Meeting template must not
// write the same headings into the body as well, and it fills the pack's
// required date.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

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
  upsertNode: async () => {}, removeNode: async () => {}, upsertAttribute: async () => {},
}));
const apiCall = vi.fn();
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: (path: string, init?: RequestInit) => apiCall(path, init),
}));

import type { Tag } from "../lib/api";
import { getAppState, resetAppState, setData, setOnline } from "../lib/appStore";
import { todayId } from "../lib/localDate";
import { useNodeCreation } from "../hooks/useNodeCreation";

type Posted = { title: string; markdown: string; tag_ids?: string[]; attributes?: Array<{ key: string; value: string }> };
const nodePosts = () => sendOrQueue.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/nodes")
  .map(([, , body]) => JSON.parse(body as string) as Posted);

const meetingTag = (pack: boolean): Tag => ({
  id: "tag-meeting", name: "meeting", color: "#7ba05b", schema_id: pack ? "tag-meeting" : null,
  schema_fields: pack ? [{ name: "meeting_date", label: "Date", type: "date", required: true }] : null,
  schema_template_children: pack ? [{ title: "Agenda" }, { title: "Decisions" }, { title: "Action items" }] : null,
});

async function createMeeting() {
  const { result } = renderHook(() => useNodeCreation({
    data: getAppState().data, createNodeRaw: vi.fn(), refresh: vi.fn(), draftTitle: "", setCreateOpen: vi.fn(),
    activeCanvas: null, addToActiveCanvas: vi.fn(), setSelectedId: vi.fn(), setMode: vi.fn(), openNote: vi.fn(), openNewTag: vi.fn(),
  }));
  await act(() => result.current.create("template", { templateId: "meeting" }));
  const posted = nodePosts();
  expect(posted).toHaveLength(1);
  return posted[0]!;
}

beforeEach(() => {
  resetAppState();
  setOnline(true);
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  apiCall.mockReset().mockImplementation(async (path: string) =>
    path === "/api/tags/resolve-path" ? { leaf_id: "tag-meeting" } : {});
});

describe("New from template: Meeting notes", () => {
  it("with the Meeting pack: one scaffold (the pack's children), and the pack's date filled", async () => {
    setData((s) => ({ ...s, tags: [meetingTag(true)] }));
    const posted = await createMeeting();
    expect(posted.tag_ids).toEqual(["tag-meeting"]);
    // The tag makes Agenda / Decisions / Action items as child notes on the
    // server; the body does not repeat them.
    expect(posted.markdown).toBe("");
    expect(posted.attributes).toEqual([{ key: "meeting_date", value: todayId() }]);
  });

  it("with a plain #meeting tag: the body scaffold, and no stray date attribute", async () => {
    setData((s) => ({ ...s, tags: [meetingTag(false)] }));
    const posted = await createMeeting();
    expect(posted.markdown).toContain("## Agenda");
    expect(posted.markdown).toContain("## Action items");
    expect(posted.attributes ?? []).toEqual([]);
  });
});
