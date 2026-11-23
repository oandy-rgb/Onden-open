// The first open after a deploy that changed the sync protocol (production 2026-11-24, 01:50 in Taipei, a phone PWA
// still on the previous build): the device holds its copy and an event cursor, today's note does not exist yet, and
// every answer from the server says it speaks a newer protocol than this page. The protocol gate (lib/protocolGate.ts)
// then keeps every sync request on the page, so the boot's membership check can never be answered. It used to count as
// a refusal: the workspace stayed behind 「正在確認工作區資料…」 until a reload brought the new build. Now it is the offline
// rule (syncEngine serverNotReached): the copy shows at once, nothing retries against the server, and today's note
// is started on this device, under the chosen note, to go out once the page is updated.
//
// Real: lib/api (and the gate inside it), lib/data (boot, sync, connectivity, dayNotes, writers, the write queue),
// lib/spaces. Faked: the network (fetch) and the on-device database (lib/localDb).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/localDb", async (original) => {
  const real = await original<typeof import("../lib/localDb")>();
  const fake: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) fake[name] = typeof value === "function" ? vi.fn() : value;
  return fake;
});
vi.mock("../lib/fileSystemStorage", () => ({
  getStoragePref: vi.fn(() => "opfs"),
  getStoredDirHandle: vi.fn(async () => null),
  requestDirPermission: vi.fn(async () => false),
  readDbFromDir: vi.fn(async () => null),
  writeDbToDir: vi.fn(async () => {}),
}));

import * as localDb from "../lib/localDb";
import { bindAccountStorage, getAccountStorageScope } from "../lib/accountStorage";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { getAppState, resetAppState, subscribeApp } from "../lib/appStore";
import { dayNotes, dayNoteParentSetting } from "../lib/data";
import { attachConnectivity, RECONNECT_RETRY_MS } from "../lib/data/connectivity";
import { dayNoteId } from "../lib/dayNode";
import { setLocalCopy } from "../lib/localCopyState";
import { todayId } from "../lib/localDate";
import { currentProtocolBlock, resetProtocolGate } from "../lib/protocolGate";
import { resetSpacesForTest, type Space } from "../lib/spaces";
import { CLIENT_PROTOCOL, isSyncPath } from "@onden/markdown";
import { memoryQueue } from "./helpers/memoryQueue";
import "../modules"; // the 日記 module supplies the day-notes feature

bindAccountStorage("me", "http://localhost");

const PERSONAL = "aaaaaaaa-1111-4111-8111-111111111111";
const personal: Space = { id: PERSONAL, name: "me", kind: "personal", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true };
const note = (id: string, title = id): ContentNode => ({ id, title, slug: id, markdown: "", source_type: "manual", node_type: "content", space_id: PERSONAL });

/** Every path the page asked the network for, in order. */
let asked: string[];
let queue: { rows: localDb.PendingWrite[] };

/** The server, updated to the next protocol: it answers every request that reaches it. */
function newerServer(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url, "http://localhost").pathname;
    asked.push(path);
    const body = path === "/api/spaces" ? { spaces: [personal] } : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "X-Onden-Server-Protocol": String(CLIENT_PROTOCOL + 1) },
    });
  }));
}

/** The browser window the connection lifecycle follows: online, nothing fired. */
const onlineWindow = { addEventListener: () => {}, removeEventListener: () => {}, navigator: { onLine: true } };

/** What this device kept from yesterday evening's session: the notes (yesterday's diary among them, today's not), the
 *  event cursor, the spaces list. */
function deviceCopyFromYesterday(yesterday: string): void {
  vi.mocked(localDb.initLocalDb).mockResolvedValue(undefined as never);
  vi.mocked(localDb.loadBootstrapList).mockResolvedValue({
    ...noWorkspaceData,
    workspace: { ...noWorkspaceData.workspace, modules: ["daily"], time_zone: "Asia/Taipei" },
    nodes: [note("journal", "日記本"), { ...note(dayNoteId(PERSONAL, yesterday), yesterday), parent_id: "journal" }],
  } as never);
  vi.mocked(localDb.loadBootstrapRelations).mockResolvedValue({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] } as never);
  vi.mocked(localDb.getLastEventId).mockResolvedValue(4200);
  vi.mocked(localDb.getWatermark).mockResolvedValue({} as never);
  vi.mocked(localDb.loadSpaces).mockImplementation(async () => (getAccountStorageScope() ? [personal] : null));
  vi.mocked(localDb.getRejectedWrites).mockResolvedValue([]);
  vi.mocked(localDb.heldNotesNowSent).mockResolvedValue([]);
  vi.mocked(localDb.loadAttributePage).mockResolvedValue({ rows: [], next: null } as never);
  vi.mocked(localDb.installUnloadFlush).mockReturnValue(() => {});
}

let detach: (() => void) | null = null;

beforeEach(() => {
  vi.resetAllMocks();
  resetAppState();
  resetSpacesForTest();
  resetProtocolGate();
  setLocalCopy("ok");
  asked = [];
  queue = memoryQueue(vi.mocked(localDb));
  dayNoteParentSetting.set("journal");
});

afterEach(() => {
  detach?.();
  detach = null;
  resetProtocolGate();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 01:50 in Taipei is still the evening before in UTC: the day changed for the workspace, not for the server.
describe.each([
  { at: "2026-11-23T17:50:54Z", today: "2026-11-24", yesterday: "2026-11-23", label: "01:50 in Taipei, 17:50 UTC the day before" },
  { at: "2026-11-23T16:00:30Z", today: "2026-11-24", yesterday: "2026-11-23", label: "just past midnight in Taipei" },
])("the first open of the day after an update, $label", ({ at, today, yesterday }) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(at));
    newerServer();
    deviceCopyFromYesterday(yesterday);
  });

  async function openTheApp(): Promise<void> {
    // The sign-in check is the page's first request: its answer already says the server is newer.
    await fetch("/api/auth/get-session");
    const { noteServerProtocol } = await import("../lib/protocolGate");
    noteServerProtocol(String(CLIENT_PROTOCOL + 1));
    detach = attachConnectivity(onlineWindow);
    await vi.advanceTimersByTimeAsync(1_000);
  }

  it("shows the workspace from the device's copy within a second, without waiting for the server", async () => {
    await openTheApp();
    expect(currentProtocolBlock()).toBe("page_old");
    expect(todayId()).toBe(today);
    expect(getAppState().bootstrapped).toBe(true);
    expect(getAppState().membershipGated).toBe(false);
    expect(getAppState().data.nodes.map((n) => n.title)).toContain(yesterday);
    expect(asked.filter(isSyncPath)).toEqual([]); // the gate held every sync request on the page
  });

  // Each reconnect attempt turns the store online for a moment, and every mounted screen that lists the spaces asks
  // for them again (lib/spaces useSpaces): a loop every RECONNECT_RETRY_MS would ask the server for nothing, and raise
  // the gate over the workspace each time.
  it("does not keep trying to reconnect while the page waits for its update", async () => {
    await openTheApp();
    const before = asked.length;
    const flips: string[] = [];
    let last = { online: getAppState().online, gated: getAppState().membershipGated };
    const stop = subscribeApp(() => {
      const now = { online: getAppState().online, gated: getAppState().membershipGated };
      if (now.online !== last.online) flips.push(`online ${now.online}`);
      if (now.gated !== last.gated) flips.push(`gated ${now.gated}`);
      last = now;
    });
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 12);
    stop();
    expect(flips).toEqual([]);
    expect(asked.slice(before)).toEqual([]);
    expect(getAppState().membershipGated).toBe(false);
  });

  it("starts today's note on this device, under the chosen note, to go out once the page is updated", async () => {
    await openTheApp();
    const opened = await dayNotes.openToday();
    expect(opened).toMatchObject({ created: true, status: "queued" });
    const posts = queue.rows.filter((row) => row.method === "POST" && row.path === "/api/nodes").map((row) => JSON.parse(row.body ?? "{}"));
    expect(posts).toEqual([expect.objectContaining({ id: dayNoteId(PERSONAL, today), title: today, parent_id: "journal" })]);
  });
});
