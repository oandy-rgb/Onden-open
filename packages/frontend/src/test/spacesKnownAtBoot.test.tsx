// The spaces list survives a reload in the local copy (lib/spaces.ts restoreSpaces / refreshSpaces → lib/data localCopy),
// so an offline start knows the personal space: today's note gets its (personal space, date) id and the chosen parent,
// a task goes into today's note or the personal 任務 note. A device that has never heard the server does not guess:
// nothing is started, a plain sentence says why, the typed words stay. findDayNode never takes another space's
// same-dated note for today's. Production 2026-11-21: a phone started that day's diary offline before the spaces
// answered — random id, top level, outside the chosen parent.
//
// Real lib/spaces, lib/data (dayNotes, writers, write queue), createQuickTask, QuickCapture, capabilities. Faked: the
// server (lib/api `api`) and the on-device database (lib/localDb), whose kept spaces are keyed by the page's account
// as the real worker is (one database per account scope).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: (path: string, init?: RequestInit) => api(path, init) }));

// What the device's database holds, per account scope; survives vi.resetModules (a page load).
const disk = vi.hoisted(() => ({ spaces: new Map<string, unknown[]>() }));
vi.mock("../lib/localDb", async (original) => {
  const real = await original<typeof import("../lib/localDb")>();
  const fake: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) fake[name] = typeof value === "function" ? vi.fn() : value;
  return fake;
});

import * as localDb from "../lib/localDb";
import { getAccountStorageScope, bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { getAppState, resetAppState, setData, setOnline } from "../lib/appStore";
import { dayNotes, dayNoteParentSetting, PersonalSpaceUnknownError } from "../lib/data";
import { dayNoteId, findDayNode, tasksNoteId } from "../lib/dayNode";
import { setLocalCopy } from "../lib/localCopyState";
import { todayId } from "../lib/localDate";
import * as spacesModule from "../lib/spaces";
import { personalSpaceId, refreshSpaces, resetSpacesForTest, type Space } from "../lib/spaces";
import { useCapabilities } from "../lib/capabilities";
import { createQuickTask, type QuickTaskFields } from "../modules/tasks/createQuickTask";
import QuickCapture from "../modules/capture/QuickCapture";
import { captureDestinationPref } from "../modules/capture/captureDestination";
import { captureProps } from "./helpers/captureProps";
import { memoryQueue } from "./helpers/memoryQueue";

bindAccountStorage("me", "http://localhost");

const PERSONAL = "aaaaaaaa-1111-4111-8111-111111111111";
const RENUMBERED = "bbbbbbbb-2222-4222-8222-222222222222";
const SHARED = "cccccccc-3333-4333-8333-333333333333";
const space = (id: string, kind: Space["kind"], permission: Space["permission"] = "edit"): Space => ({
  id, name: kind === "personal" ? "me" : "Team", kind, is_default: kind === "shared", owner_actor_id: null,
  capabilities: {}, permission, can_manage: kind === "personal",
});
const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", space_id: PERSONAL, ...extra,
});
const today = () => todayId();
const task: QuickTaskFields = {
  title: "交報告", when_date: null, time: null, evening: false, someday: false, deadline: null,
  recur: null, recur_mode: "fixed", remind_at: null, note: null,
};

let queue: { rows: localDb.PendingWrite[] };
/** The creates queued for the server (offline), as the server will get them. */
const queuedPosts = (path: string) => queue.rows.filter((r) => r.method === "POST" && r.path === path)
  .map((r) => JSON.parse(r.body ?? "{}") as { id?: string; title?: string; parent_id?: string | null; into?: { note_id: string }; space_id?: string });
/** The server's spaces list for this account; null: unreachable. */
let serverSpaces: Space[] | null;

beforeEach(() => {
  vi.resetAllMocks(); // the fake localDb functions now answer undefined: give the ones the path reads real answers
  resetAppState();
  resetSpacesForTest();
  setLocalCopy("ok");
  disk.spaces.clear();
  serverSpaces = null;
  queue = memoryQueue(vi.mocked(localDb));
  // Guarded so this file also runs (red) against the code from before the fix, which had neither.
  if (Object.keys(localDb).includes("loadSpaces")) vi.mocked(localDb.loadSpaces).mockImplementation(async () => disk.spaces.get(getAccountStorageScope()) ?? null);
  if (Object.keys(localDb).includes("storeSpaces")) vi.mocked(localDb.storeSpaces).mockImplementation(async (list) => { disk.spaces.set(getAccountStorageScope(), list); });
  vi.mocked(localDb.getRejectedWrites).mockImplementation(async () => []);
  vi.mocked(localDb.getLastEventId).mockImplementation(async () => 0);
  api.mockImplementation(async (path: string) => {
    if (path === "/api/spaces" && serverSpaces) return { spaces: serverSpaces };
    throw new TypeError("Failed to fetch"); // offline: nothing answers
  });
  setData({ ...noWorkspaceData, nodes: [note("journal")], workspace: { ...noWorkspaceData.workspace, modules: ["daily", "tasks"] } });
  dayNoteParentSetting.set("journal");
  setOnline(false);
});

/** This device heard the server once (an earlier, online start): the list is in its copy. */
const keptFromEarlierStart = (spaces: Space[]) => disk.spaces.set(getAccountStorageScope(), spaces);
/** What the boot does before the first paint (lib/data/syncEngine runBoot). */
const restoreSpaces = async () => { await spacesModule.restoreSpaces?.(); };
const setModules = (modules: string[]) => setData((s) => ({ ...s, workspace: { ...s.workspace, modules } }));

describe("offline cold start, the spaces kept from an earlier start", () => {
  beforeEach(async () => {
    keptFromEarlierStart([space(PERSONAL, "personal"), space(SHARED, "shared", "view")]);
    await restoreSpaces();
  });

  it("knows the personal space at once", () => {
    expect(personalSpaceId()).toBe(PERSONAL);
  });

  it("starts today's note with the (personal space, date) id, under the chosen parent", async () => {
    const opened = await dayNotes.openToday();
    expect(queuedPosts("/api/nodes")).toEqual([expect.objectContaining({ id: dayNoteId(PERSONAL, today()), title: today(), parent_id: "journal" })]);
    expect(opened).toMatchObject({ created: true, status: "queued" });
  });

  it("puts a personal-space task into today's note (diary on), or the personal 任務 note under the parent (diary off)", async () => {
    expect(await createQuickTask({ ...task, spaceId: PERSONAL })).toMatchObject({ saved: "queued", noteTitle: today() });
    expect(queuedPosts("/api/tasks").map((p) => p.into?.note_id)).toEqual([dayNoteId(PERSONAL, today())]);

    setModules(["tasks"]); // 日記 off
    await createQuickTask({ ...task, title: "繳費" });
    const tasksNote = queuedPosts("/api/nodes").find((p) => p.title === "任務");
    expect(tasksNote).toMatchObject({ id: tasksNoteId(PERSONAL) });
    expect(tasksNote?.parent_id ?? null).toBeNull(); // the diary parent applies while the module is on
    expect(tasksNote?.space_id).toBeUndefined(); // the personal one, not a shared space's
    expect(queuedPosts("/api/tasks").map((p) => p.into?.note_id)).toEqual([dayNoteId(PERSONAL, today()), tasksNoteId(PERSONAL)]);
  });

  it("reads a 只能看 shared note as not editable offline", () => {
    const { result } = renderHook(() => useCapabilities(false));
    expect(result.current.canEdit(note("shared-note", { space_id: SHARED }))).toBe(false);
    expect(result.current.canEdit(note("mine"))).toBe(true);
  });
});

describe("a new device, offline: nothing kept", () => {
  beforeEach(async () => { await restoreSpaces(); });

  it("starts no day note and says why in plain words", async () => {
    expect(personalSpaceId()).toBeNull();
    const refused = dayNotes.openToday();
    await expect(refused).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
    await expect(refused).rejects.toThrow("Today's diary is started once this device has connected to the internet.");
    expect(queuedPosts("/api/nodes")).toEqual([]);
  });

  it("sends no task to a guessed note (diary on or off)", async () => {
    await expect(createQuickTask(task)).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
    setModules(["tasks"]);
    await expect(createQuickTask(task)).rejects.toThrow("Tasks without a note can be saved once this device has connected to the internet.");
    expect(queue.rows.filter((r) => r.path === "/api/nodes" || r.path === "/api/tasks")).toEqual([]);
  });

  it("keeps a capture's words in the box, and says so once", async () => {
    captureDestinationPref.store.save("today");
    render(<QuickCapture {...captureProps({ online: false })} initialDraft="買牛奶" />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("買牛奶");
    expect(getAppState().toasts.map((t) => t.message)).toEqual(["Today's diary is started once this device has connected to the internet."]);
    expect(queuedPosts("/api/nodes")).toEqual([]);
  });

  it("knows the space once the server answers, and keeps it for the next start", async () => {
    serverSpaces = [space(PERSONAL, "personal")];
    setOnline(true);
    await refreshSpaces();
    expect(personalSpaceId()).toBe(PERSONAL);
    resetSpacesForTest(); // the next page load
    await restoreSpaces();
    expect(personalSpaceId()).toBe(PERSONAL);
  });
});

describe("the server renumbered the personal space", () => {
  it("replaces the kept id once it answers; later day notes use the new space", async () => {
    keptFromEarlierStart([space(PERSONAL, "personal")]);
    await restoreSpaces();
    expect(personalSpaceId()).toBe(PERSONAL);
    serverSpaces = [space(RENUMBERED, "personal")];
    setOnline(true);
    // Online, before the server has answered on this page, today's note waits for it rather than the kept copy.
    await dayNotes.openToday();
    expect(queuedPosts("/api/nodes").map((p) => p.id)).toEqual([dayNoteId(RENUMBERED, today())]);
    expect(disk.spaces.get(getAccountStorageScope())).toEqual([space(RENUMBERED, "personal")]);
    resetSpacesForTest(); // next start, offline
    setOnline(false);
    await restoreSpaces();
    expect(personalSpaceId()).toBe(RENUMBERED);
  });
});

describe("a same-dated note in a shared space", () => {
  const theirs = () => note(today(), { id: "team-day", space_id: SHARED });

  it("is never today's note — personal space unknown or known", async () => {
    setData((s) => ({ ...s, nodes: [...s.nodes, theirs()] }));
    await restoreSpaces(); // nothing kept: unknown
    expect(findDayNode(getAppState().data.nodes)).toBeUndefined();
    await expect(dayNotes.openToday()).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
    await expect(createQuickTask(task)).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
    expect(queuedPosts("/api/tasks")).toEqual([]);

    keptFromEarlierStart([space(PERSONAL, "personal"), space(SHARED, "shared")]);
    await restoreSpaces();
    expect(findDayNode(getAppState().data.nodes)).toBeUndefined();
    await createQuickTask(task);
    expect(queuedPosts("/api/tasks").map((p) => p.into?.note_id)).toEqual([dayNoteId(PERSONAL, today())]);
  });

  it("random workspaces: findDayNode only ever answers with the personal space's (or this device's unsent) note", () => {
    const seed = Date.now() >>> 0;
    console.log(`[spacesKnownAtBoot] random seed ${seed}`);
    let state = seed || 1;
    const next = () => { state = (state * 1103515245 + 12345) >>> 0; return state / 2 ** 32; };
    const spaces = [PERSONAL, SHARED, "dddddddd-4444-4444-8444-444444444444", null];
    for (let round = 0; round < 200; round++) {
      const nodes = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, i) => note(`n${i}`, {
        title: next() < 0.6 ? today() : "2026-01-01", space_id: spaces[Math.floor(next() * spaces.length)],
      }));
      const own = next() < 0.3 ? null : PERSONAL;
      const found = findDayNode(nodes, today(), own);
      if (own === null) expect(found, `seed ${seed} round ${round}`).toBeUndefined();
      else if (found) expect([PERSONAL, null], `seed ${seed} round ${round}`).toContain(found.space_id ?? null);
      else expect(nodes.some((n) => n.title === today() && (!n.space_id || n.space_id === PERSONAL)), `seed ${seed} round ${round}`).toBe(false);
    }
  });
});

describe("another account on this device", () => {
  it("never reads the first account's kept spaces", async () => {
    keptFromEarlierStart([space(PERSONAL, "personal")]);
    // A sign-in as someone else is a new page lifetime (lib/accountStorage binds once).
    vi.resetModules();
    const accounts = await import("../lib/accountStorage");
    expect(accounts.bindAccountStorage("someone-else", "http://localhost")).toBe(true);
    await import("../lib/localCopyState").then((m) => m.setLocalCopy("ok"));
    const spaces = await import("../lib/spaces");
    const fresh = await import("../lib/localDb");
    vi.mocked(fresh.loadSpaces).mockImplementation(async () => disk.spaces.get(accounts.getAccountStorageScope()) ?? null);
    await spaces.restoreSpaces();
    expect(spaces.personalSpaceId()).toBeNull();
    expect([...disk.spaces.keys()]).toHaveLength(1);
  });
});

it("boot takes the kept spaces before it paints", async () => {
  // The boot's order matters: the first paint lands on today, so the personal space must be known by then.
  const source = (await import("../lib/data/syncEngine.ts?raw")).default as string;
  const boot = source.slice(source.indexOf("async function runBoot("));
  expect(boot.indexOf("await restoreSpaces()")).toBeGreaterThan(-1);
  expect(boot.indexOf("await restoreSpaces()")).toBeLessThan(boot.indexOf("loadBootstrapList()"));
});
