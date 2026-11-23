// Today's note has one entry, lib/data/dayNotes.ts (D68): the Today button,
// quick capture, the agenda quick-add and the "Daily note" template all open
// the same note, two devices starting it converge on one id, and the template
// never mints a second note titled with today's date.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Every write lands in `sendOrQueue(method, path, body)`; undefined is the
// queued (offline) branch, a value is the server's answer.
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
const space = vi.hoisted(() => ({ id: "11111111-2222-4333-8444-555555555555" as string | null }));
vi.mock("../lib/spaces", async (original) => ({
  ...await original<typeof import("../lib/spaces")>(),
  personalSpaceId: () => space.id,
}));

import QuickCapture from "../modules/capture/QuickCapture";
import { captureDestinationPref } from "../modules/capture/captureDestination";
import { captureProps } from "./helpers/captureProps";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData, type Bootstrap, type ContentNode } from "../lib/api";
import { getAppState, resetAppState, setData, setOnline } from "../lib/appStore";
import { dayNotes, PersonalSpaceUnknownError } from "../lib/data";
import { dayNoteId, makeDayNotes } from "../lib/data/dayNotes";
import type { DataCtx } from "../lib/data/types";
import { nameBasedUUID } from "../lib/uuid";
import { useNodeCreation } from "../hooks/useNodeCreation";
import { useDayNoteWrites } from "../hooks/useDayNoteWrites";
import { todayId } from "../lib/localDate";

const today = () => todayId();
const dayNote = (id: string, markdown: string): ContentNode => ({
  id, title: today(), slug: today(), markdown, source_type: "manual", node_type: "content", space_id: space.id,
});
const nodePosts = () => sendOrQueue.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/nodes")
  .map(([, , body]) => JSON.parse(body as string) as { id: string; title: string; markdown: string; tag_ids?: string[]; parent_id?: string });

/** One device: its own store, whose reload brings `serverNodes()`. */
function deviceWith(serverNodes: () => ContentNode[]) {
  let state: Bootstrap = { ...noWorkspaceData, nodes: [] };
  const ctx: DataCtx = {
    get data() { return state; }, online: true,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(),
    refresh: vi.fn(async () => { state = { ...state, nodes: serverNodes() }; }),
  };
  return { ctx, notes: makeDayNotes(ctx), nodes: () => state.nodes };
}

function creationHook() {
  const setSelectedId = vi.fn();
  const openNote = vi.fn();
  const { result } = renderHook(() => useNodeCreation({
    data: getAppState().data, createNodeRaw: vi.fn(), refresh: vi.fn(), draftTitle: "", setCreateOpen: vi.fn(),
    activeCanvas: null, addToActiveCanvas: vi.fn(), setSelectedId, setMode: vi.fn(), openNote, openNewTag: vi.fn(),
  }));
  return { result, setSelectedId, openNote };
}

beforeEach(() => {
  resetAppState();
  setOnline(true);
  space.id = "11111111-2222-4333-8444-555555555555";
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  apiCall.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/tags/resolve-path") return { leaf_id: "tag-daily" };
    return {};
  });
});

describe("name-based ids", () => {
  it("matches the RFC 9562 version-5 test vector", () => {
    expect(nameBasedUUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("gives one id per personal space and date, the same on every call", () => {
    const id = dayNoteId("space-a", "2026-10-17");
    expect(id).toBe(dayNoteId("space-a", "2026-10-17"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(dayNoteId("space-b", "2026-10-17")).not.toBe(id);
    expect(dayNoteId("space-a", "2026-10-18")).not.toBe(id);
  });
});

describe("dayNotes.openToday across a changed clock", () => {
  // 10/26 17:00 UTC is already 10/27 in Taipei and still 10/26 in UTC; with a
  // 10/26 in Taipei when the day starts at 04:00).
  const NOW = new Date("2026-10-26T17:00:00Z");
  const useClock = (time_zone: string | null, day_start_hour = 0) =>
    setData((d) => ({ ...d, timezone: undefined, workspace: { ...d.workspace, time_zone, day_start_hour } }));

  it("the date follows the workspace's clock, and one date is never started twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      let created: ContentNode[] = [];
      sendOrQueue.mockImplementation(async (_method: string, _path: string, body: string) => {
        const sent = JSON.parse(body) as ContentNode;
        const note = { ...sent, slug: sent.title };
        created = [...created.filter((n) => n.id !== note.id), note];
        return note;
      });
      const device = deviceWith(() => created);

      useClock("UTC");
      const utcDay = await device.notes.openToday();
      expect(utcDay).toMatchObject({ created: true, node: { title: "2026-10-26" } });

      useClock("Asia/Taipei"); // the owner moves the clock forward: a new date, a new note
      const taipeiDay = await device.notes.openToday();
      expect(taipeiDay).toMatchObject({ created: true, node: { title: "2026-10-27" } });

      useClock("UTC"); // and back: the first date's note is found, not started again
      const again = await device.notes.openToday();
      expect(again).toMatchObject({ created: false, node: { title: "2026-10-26" } });
      useClock("Asia/Taipei", 0);
      expect(await device.notes.openToday()).toMatchObject({ created: false, node: { title: "2026-10-27" } });

      // the day start hour moves the date back a day (01:00 in Taipei is before 04:00)
      useClock("Asia/Taipei", 4);
      expect(await device.notes.openToday()).toMatchObject({ created: false, node: { title: "2026-10-26" } });

      const titles = device.nodes().map((n) => n.title).sort();
      expect(titles).toEqual(["2026-10-26", "2026-10-27"]);
      expect(nodePosts().map((p) => p.id)).toEqual([dayNoteId(space.id!, "2026-10-26"), dayNoteId(space.id!, "2026-10-27")]);
    } finally { vi.useRealTimers(); }
  });
});

describe("dayNotes.openToday", () => {
  it("two devices starting today's note converge on one note", async () => {
    // Each device has its own store; the server keeps whichever create came first.
    let server: ContentNode | null = null;
    const device = () => deviceWith(() => (server ? [server] : []));
    sendOrQueue.mockImplementation(async (_method: string, _path: string, body: string) => {
      const sent = JSON.parse(body) as ContentNode;
      if (server?.id === sent.id) return { deduped: true }; // same Idempotency-Key
      server = { ...sent, slug: sent.title, markdown: "written on A" };
      return server;
    });
    const a = device();
    const b = device();
    const first = await a.notes.openToday();
    const second = await b.notes.openToday();
    const posted = nodePosts();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.id).toBe(posted[0]!.id);
    expect(posted[0]!.id).toBe(dayNoteId(space.id!, today()));
    expect(first).toMatchObject({ created: true, node: { id: posted[0]!.id } });
    // B learns the note exists, re-reads, and opens A's note — it does not start another.
    expect(second).toMatchObject({ created: false, node: { id: posted[0]!.id, markdown: "written on A" } });
    expect(b.ctx.refresh).toHaveBeenCalledOnce();
    expect(b.nodes().map((n) => n.id)).toEqual([posted[0]!.id]);
  });

  it("starts a fresh note when the derived id is taken but today's note is gone (deleted)", async () => {
    sendOrQueue.mockResolvedValueOnce({ deduped: true }).mockResolvedValueOnce(undefined);
    const device = deviceWith(() => []); // the server's copy is in the trash
    const opened = await device.notes.openToday();
    const posted = nodePosts();
    expect(posted).toHaveLength(2);
    expect(posted[0]!.id).toBe(dayNoteId(space.id!, today()));
    expect(posted[1]!.id).not.toBe(posted[0]!.id);
    expect(opened).toMatchObject({ created: true, status: "queued", node: { id: posted[1]!.id, title: today() } });
  });

  // 2026-11-21 (a phone, offline): a random id at the top level. Unknown now refuses and writes nothing.
  it("starts nothing while the personal space is unknown", async () => {
    space.id = null;
    await expect(dayNotes.openToday()).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
    expect(nodePosts()).toEqual([]);
  });

  it("only looks with create: false", async () => {
    expect(await dayNotes.openToday({ create: false })).toBeNull();
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe("the Daily note template", () => {
  it("opens today's note when it has content: no second note, no scaffold", async () => {
    const existing = dayNote("day-1", "captured earlier");
    setData((s) => ({ ...s, nodes: [existing] }));
    const { result, setSelectedId } = creationHook();
    await act(() => result.current.create("template", { templateId: "daily" }));
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(apiCall).not.toHaveBeenCalled(); // no #daily minted for an unused scaffold
    expect(setSelectedId).toHaveBeenCalledWith("day-1");
    expect(getAppState().data.nodes.filter((n) => n.title === today())).toHaveLength(1);
  });

  it("stamps its scaffold onto today's empty note instead of creating one", async () => {
    setData((s) => ({ ...s, nodes: [dayNote("day-1", "")] }));
    const { result, openNote } = creationHook();
    await act(() => result.current.create("template", { templateId: "daily" }));
    expect(nodePosts()).toHaveLength(0);
    const patch = sendOrQueue.mock.calls.find(([method, path]) => method === "PATCH" && path === "/api/nodes/day-1");
    expect(JSON.parse(patch![2] as string).markdown).toMatch(new RegExp(`^# ${today()}\\n`));
    expect(sendOrQueue).toHaveBeenCalledWith("PUT", "/api/nodes/day-1/tags/tag-daily", "{}");
    expect(openNote).toHaveBeenCalledWith("day-1");
  });

  it("starts today's note with the scaffold when there is none", async () => {
    const { result, openNote } = creationHook();
    await act(() => result.current.create("template", { templateId: "daily" }));
    const [posted] = nodePosts();
    expect(nodePosts()).toHaveLength(1);
    expect(posted).toMatchObject({ id: dayNoteId(space.id!, today()), title: today(), tag_ids: ["tag-daily"] });
    expect(posted!.markdown).toMatch(new RegExp(`^# ${today()}\\n`));
    expect(openNote).toHaveBeenCalledWith(posted!.id);
  });
});

describe("every surface opens the same note", () => {
  it("capture, agenda quick-add and the Today button all use today's one note", async () => {
    // Quick capture, set to go to today's journal, starts today's note (offline: queued).
    bindAccountStorage("day-user", "http://localhost");
    captureDestinationPref.store.save("today");
    render(<QuickCapture {...captureProps({ online: false })} initialDraft="a thought" />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dayId = dayNoteId(space.id!, today());
    expect(nodePosts().map((p) => p.parent_id ?? p.id)).toEqual([dayId, dayId]);

    // The agenda quick-add hangs its task on that note, without another create.
    const addTask = vi.fn(async () => ({}));
    const agenda = renderHook(() => useDayNoteWrites({ addTaskRaw: addTask as never, openDailyNote: vi.fn() }));
    await act(() => agenda.result.current.createAgendaTask("Call dentist"));
    expect(addTask).toHaveBeenCalledWith(dayId, "Call dentist", undefined);

    // The Today button opens it too.
    const { result, setSelectedId } = creationHook();
    let opened: string | null = null;
    await act(async () => { opened = await result.current.openDailyNote(); });
    expect(opened).toBe(dayId);
    expect(setSelectedId).toHaveBeenCalledWith(dayId);
    expect(nodePosts().filter((p) => p.title === today())).toHaveLength(1);
  });
});
