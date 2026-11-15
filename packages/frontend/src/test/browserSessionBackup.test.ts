// What the page asks the worker for when it hands a temporary session on (lib/browserAppBackup.ts makeSessionBackupBlob),
// and the browser's "leave this page?" question (lib/pageHide.ts warnBeforeLeaving).
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSessionBackupBlob } from "../lib/browserAppBackup";
import { warnBeforeLeaving } from "../lib/pageHide";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function stubFetch(ok = true) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); return new Response(ok ? "zip" : "no", { status: ok ? 200 : 500 }); }));
  return calls;
}

describe("the backup of a temporary session", () => {
  it("asks only for what was written; with no options that is everything written", async () => {
    const calls = stubFetch();
    const { blob, cursor } = await makeSessionBackupBlob();
    expect(calls).toEqual(["/api/backup/full.zip?written=1"]);
    expect(await blob.text()).toBe("zip");
    expect(new Date(cursor).toISOString()).toBe(cursor);
  });

  it("can ask for what changed since the last time, or for particular notes", async () => {
    const calls = stubFetch();
    await makeSessionBackupBlob({ since: "2026-11-12T10:00:00.000Z", noteIds: ["a", "b"] });
    expect(calls).toEqual(["/api/backup/full.zip?written=1&since=2026-11-12T10%3A00%3A00.000Z&note=a&note=b"]);
  });

  it("the cursor is read before the request, so a note written while it runs is in the next one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => { vi.setSystemTime(new Date("2026-11-12T10:00:05.000Z")); return new Response("zip"); }));
    expect((await makeSessionBackupBlob()).cursor).toBe("2026-11-12T10:00:00.000Z");
  });

  it("says so when the worker refuses", async () => {
    stubFetch(false);
    await expect(makeSessionBackupBlob()).rejects.toThrow("backup failed");
  });
});

describe("the browser's question before leaving", () => {
  it("is asked only while there is something not downloaded", () => {
    let unsent = false;
    const stop = warnBeforeLeaving(() => unsent);
    const quiet = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    unsent = true;
    const asked = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(asked);
    expect(asked.defaultPrevented).toBe(true);
    stop();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
