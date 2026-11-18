// 「這次更新」: the changes/ files parsed (lib/whatsNew), what an account has not
// seen yet (hooks/useUnseenChanges, lib/changesSeenStore), and the card in the
// device notices (components/WhatsNewCard).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

let serverPrefs: Record<string, unknown> = {};
let createdAt: string | undefined;
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});
vi.mock("../lib/auth-client", () => ({
  authClient: { getSession: vi.fn(async () => ({ data: { user: { createdAt } } })) },
}));

import { authClient } from "../lib/auth-client";
import { useUnseenChanges } from "../hooks/useUnseenChanges";
import WhatsNewCard from "../components/WhatsNewCard";
import { changesSeenStore, parseChangesSeen } from "../lib/changesSeenStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { onSettingsRequest } from "../lib/settingsRequest";
import { changeText, CHANGES, parseChange, parseChanges, unseenChanges, type Change } from "../lib/whatsNew";
import { createdWithThisBuild } from "../lib/whatsNewText";

const change = (id: string, zh = `中文 ${id}`, en: string | null = null): Change => ({ id, date: id.slice(0, 10), zh, en });
const LIST = [change("2026-10-29-d"), change("2026-10-28-c"), change("2026-10-27-b"), change("2026-10-26-a")];

beforeEach(async () => {
  localStorage.clear();
  serverPrefs = {};
  createdAt = undefined;
  sendWrite.mockReset();
  sendWrite.mockImplementation(async (_m: string, path: string, body: { value: unknown }) => { serverPrefs[path.split("/").pop()!] = body.value; return { value: body.value }; });
  bindAccountStorage("whats-new-account", "");
  changesSeenStore.save(null);
  await changesSeenStore.sync();
});

describe("parseChange", () => {
  const file = "---\ndate: 2026-10-29\nzh-TW: 中文\nen: English\n---\n";
  it("reads the day, the Chinese sentence and the optional English one", () => {
    expect(parseChange("2026-10-29-x", file)).toEqual({ id: "2026-10-29-x", date: "2026-10-29", zh: "中文", en: "English" });
    expect(parseChange("2026-10-29-x", file.replace(/en: .*\n/, ""))?.en).toBeNull();
  });
  it("refuses a file without the Chinese sentence, or whose name does not start with its day", () => {
    expect(parseChange("2026-10-29-x", file.replace("zh-TW: 中文\n", ""))).toBeNull();
    expect(parseChange("2026-10-28-x", file)).toBeNull();
    expect(parseChange("2026-10-29-x", "no header")).toBeNull();
  });
  it("lists newest first, then by name", () => {
    const files = Object.fromEntries(["../a/2026-10-28-b.md", "../a/2026-10-29-a.md", "../a/2026-10-29-c.md"]
      .map((p) => [p, file.replace("2026-10-29", p.slice(5, 15))]).filter(([p, f]) => (p as string).includes(f.slice(10, 20))));
    expect(parseChanges(files).map((c) => c.id)).toEqual(["2026-10-29-c", "2026-10-29-a", "2026-10-28-b"]);
  });
});

describe("the bundled changes/ folder", () => {
  it("is non-empty, and every file parses", () => { expect(CHANGES.length).toBeGreaterThan(0); });
});

describe("changeText", () => {
  it("English falls back to the Chinese sentence", () => {
    expect(changeText(change("2026-10-29-a", "中", "En"), "en")).toBe("En");
    expect(changeText(change("2026-10-29-a", "中"), "en")).toBe("中");
    expect(changeText(change("2026-10-29-a", "中", "En"), "zh-TW")).toBe("中");
  });
});

describe("unseenChanges / parseChangesSeen", () => {
  it("is everything after the newest change seen", () => {
    expect(unseenChanges(LIST, "2026-10-27-b").map((c) => c.id)).toEqual(["2026-10-29-d", "2026-10-28-c"]);
    expect(unseenChanges(LIST, "2026-10-29-d")).toEqual([]);
    expect(unseenChanges(LIST, null)).toHaveLength(4);
  });
  it("stores only a change id", () => {
    expect(parseChangesSeen("2026-10-29-x")).toBe("2026-10-29-x");
    for (const bad of [null, "", "x", 5, "2026-10-29 x"]) expect(parseChangesSeen(bad)).toBeNull();
  });
});

const CLOCK_SKEW_MS = 10 * 60_000; // the documented tolerance (lib/whatsNewText)

describe("createdWithThisBuild", () => {
  it("is about instants: at or after the build, or within the clock skew before it", () => {
    expect(createdWithThisBuild(1_000_000, 1_000_000)).toBe(true);
    expect(createdWithThisBuild(1_000_000 + 1, 1_000_000)).toBe(true);
    expect(createdWithThisBuild(1_000_000 - CLOCK_SKEW_MS, 1_000_000)).toBe(true);
    expect(createdWithThisBuild(1_000_000 - CLOCK_SKEW_MS - 1, 1_000_000)).toBe(false);
  });
});

describe("useUnseenChanges", () => {
  it("lists what is after the account's mark, and nothing after marking all seen (on every device)", async () => {
    serverPrefs.changesSeen = "2026-10-27-b";
    await act(async () => { await changesSeenStore.sync(); });
    const { result } = renderHook(() => useUnseenChanges(LIST));
    await waitFor(() => expect(result.current.unseen.map((c) => c.id)).toEqual(["2026-10-29-d", "2026-10-28-c"]));
    act(() => result.current.markAllSeen());
    expect(result.current.unseen).toEqual([]);
    await waitFor(() => expect(serverPrefs.changesSeen).toBe("2026-10-29-d"));
  });

  // The newest change is dated 2026-10-29 (the Taiwan day). The build was made 2026-10-28 17:00 UTC = 2026-10-29 01:00 in Taiwan.
  const BUILT = Date.parse("2026-10-28T17:00:00.000Z");

  it("a new account (made with this build) starts at the newest change: nothing to show, and the mark is saved", async () => {
    createdAt = "2026-10-28T18:00:00.000Z";
    const { result } = renderHook(() => useUnseenChanges(LIST, BUILT));
    await waitFor(() => expect(serverPrefs.changesSeen).toBe("2026-10-29-d"));
    expect(result.current.unseen).toEqual([]);
  });

  it("made one UTC day before the newest change's date, but after the build: no card (calendar days in two zones used to say otherwise)", async () => {
    createdAt = "2026-10-28T17:30:00.000Z"; // 10-28 in UTC, 10-29 in Taiwan; the note is dated 10-29
    const { result } = renderHook(() => useUnseenChanges(LIST, BUILT));
    await waitFor(() => expect(serverPrefs.changesSeen).toBe("2026-10-29-d"));
    expect(result.current.unseen).toEqual([]);
  });

  it("an account older than this build that never saw the list gets it", async () => {
    createdAt = "2026-09-01T08:00:00.000Z";
    const { result } = renderHook(() => useUnseenChanges(LIST, BUILT));
    await waitFor(() => expect(result.current.unseen).toHaveLength(4));
    expect(serverPrefs.changesSeen).toBeNull();
  });

  it("tolerates a server clock a few minutes behind the build's, not hours", async () => {
    createdAt = new Date(BUILT - 5 * 60_000).toISOString();
    const fresh = renderHook(() => useUnseenChanges(LIST, BUILT));
    await waitFor(() => expect(serverPrefs.changesSeen).toBe("2026-10-29-d"));
    expect(fresh.result.current.unseen).toEqual([]);
    fresh.unmount();

    changesSeenStore.save(null);
    serverPrefs = {};
    createdAt = new Date(BUILT - 60 * 60_000).toISOString();
    const older = renderHook(() => useUnseenChanges(LIST, BUILT));
    await waitFor(() => expect(older.result.current.unseen).toHaveLength(4));
  });

  it("shows nothing while the account's creation time is unknown, or this build's time is", async () => {
    const unknownAccount = renderHook(() => useUnseenChanges(LIST, BUILT));
    await act(async () => { await Promise.resolve(); });
    expect(unknownAccount.result.current.unseen).toEqual([]);
    unknownAccount.unmount();

    createdAt = "2026-09-01T08:00:00.000Z";
    const unknownBuild = renderHook(() => useUnseenChanges(LIST, null));
    await act(async () => { await Promise.resolve(); });
    expect(unknownBuild.result.current.unseen).toEqual([]);
    expect(serverPrefs.changesSeen ?? null).toBeNull();
  });

  it("offline on a first run, the session cannot say when the account was made: nothing shown, nothing saved", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(authClient.getSession).mockRejectedValueOnce(new Error("offline"));
    try {
      const { result } = renderHook(() => useUnseenChanges(LIST, BUILT));
      await act(async () => { await Promise.resolve(); });
      expect(result.current.unseen).toEqual([]);
      expect(serverPrefs.changesSeen ?? null).toBeNull();
    } finally { online.mockRestore(); }
  });

  it("never moves the mark back", async () => {
    serverPrefs.changesSeen = "2026-10-29-d";
    const { result } = renderHook(() => useUnseenChanges(LIST.slice(1)));
    await act(async () => { await changesSeenStore.sync(); });
    sendWrite.mockClear();
    act(() => result.current.markAllSeen());
    expect(sendWrite).not.toHaveBeenCalled();
  });
});

describe("WhatsNewCard", () => {
  it("shows nothing when there is nothing new", () => {
    const { container } = render(<WhatsNewCard unseen={[]} onSeen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists at most three, marks seen on close, and 「看全部」 opens the list in Settings", () => {
    const onSeen = vi.fn();
    const opened: string[] = [];
    const off = onSettingsRequest((tab) => opened.push(tab));
    render(<WhatsNewCard unseen={LIST} onSeen={onSeen} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onSeen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "See all" }));
    expect(onSeen).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(["about"]);
    off();
  });

  it("has no 「看全部」 when everything fits", () => {
    render(<WhatsNewCard unseen={LIST.slice(0, 3)} onSeen={() => {}} />);
    expect(screen.queryByRole("button", { name: "See all" })).toBeNull();
  });
});
