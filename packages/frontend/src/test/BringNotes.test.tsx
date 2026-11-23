// The browser version taking a file from another device: BringNotes.tsx, BringEntry.tsx, bringNotes.ts.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JoinFileResult, WorkerClient } from "../lib/browserAppWorker";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(), erase: vi.fn(), reload: vi.fn(), confirm: vi.fn(),
  storage: vi.fn(), stopWaiting: vi.fn(),
}));
vi.mock("../lib/browserAppBridge", () => ({ eraseBrowserCopy: mocks.erase }));
vi.mock("../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/data")>()), reads: { workspace: { snapshotReadiness: mocks.readiness } }, deviceFileHistory: { stopWaiting: mocks.stopWaiting } }));
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), reloadPage: mocks.reload }));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("../lib/storagePersist", () => ({ storageStatus: mocks.storage }));

import BringNotes from "../browserApp/BringNotes";
import BringEntry from "../browserApp/BringEntry";
import { keptBytesOf, readBringState, roomNeeded, writeBringState } from "../browserApp/bringNotes";

const file = (text: string) => new File([text], "from-the-other-device.ndjson");
const NONE = { own_notes: 0, trash: 0, own_tags: 0, spaces: 0, files: 0, prefs: 0 };
const EMPTY = { ready: true, holds: NONE };
const HOLDING = { ready: false, code: "join_not_empty", kind: "own_notes", holds: { ...NONE, own_notes: 3, trash: 2, own_tags: 1 } };
const hello = '{"kind":"hello","workspaceId":"w","source":"s","cut":1,"person":"p"}\n';
const join = vi.fn<(file: Blob, progress: (read: number, total: number) => void) => Promise<JoinFileResult>>();
const client = { joinFile: join, reset: vi.fn() } as unknown as WorkerClient;

const choose = async (user: ReturnType<typeof userEvent.setup>, content = hello) => {
  const input = (await screen.findByLabelText("The file from your other device", { selector: "input" })) as HTMLInputElement;
  await user.upload(input, file(content));
};
const refused = (error: string | null, detail: string | null = null, status = 409): JoinFileResult => ({ ok: false, status, error, detail });
/** The notes are in; `over` says where their earlier versions are. */
const taken = (over: Partial<Extract<JoinFileResult, { ok: true }>> = {}): JoinFileResult =>
  ({ ok: true, pages: 3, rows: 120, history: "done", historyScope: "all", historyLeftOut: 0, historyRefused: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readiness.mockResolvedValue(EMPTY);
  mocks.storage.mockResolvedValue({ persistent: true, usedBytes: 1000, quotaBytes: 10 ** 12 });
  mocks.confirm.mockResolvedValue(true);
  writeBringState(null);
});

describe("an empty copy asking for the file", () => {
  it("says what it does and does not do, in plain words", async () => {
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await screen.findByRole("button", { name: "Choose the file from your other device…" });
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/It is a copy: afterwards/);
    expect(text).toMatch(/do not update each other/);
    expect(text).toMatch(/Nothing is uploaded anywhere/);
    expect(text).toMatch(/Pictures and files .* not in the file yet/);
    expect(text).not.toMatch(/snapshot|ndjson|json|stamp|join_/i);
  });

  it("a page that was cut off in the middle says so and that nothing was kept", async () => {
    render(<BringNotes client={client} interrupted onLeave={() => {}} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/Nothing was kept: this device is empty and can try again/);
  });

  it("a file that is not from another device is told at once and the copy is not touched", async () => {
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user, "just some text\n");
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a file made on your other device/);
    expect(join).not.toHaveBeenCalled();
    expect(readBringState()).toBeNull();
  });

  it("a file the browser has no room for is refused before it is read", async () => {
    mocks.storage.mockResolvedValue({ persistent: true, usedBytes: 0, quotaBytes: 10 });
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not have room/);
    expect(join).not.toHaveBeenCalled();
  });

  it("the room asked for is for what is kept, read from the file's last line: not the notes again on a device that has them, not the drawings' history over the threshold", async () => {
    const MB = 1024 * 1024;
    const manifest = (rows: number, history: number, inkBytes: number) => `${hello}{"kind":"manifest","pages":1,"digest":[],"history":{"pages":1,"digests":{},"inkBytes":${inkBytes}},"bytes":{"rows":${rows},"history":${history}}}\n`;
    expect(await keptBytesOf(file(manifest(100 * MB, 300 * MB, 10 * MB)), false)).toBe(400 * MB);
    expect(await keptBytesOf(file(manifest(100 * MB, 300 * MB, 10 * MB)), true)).toBe(300 * MB);
    expect(await keptBytesOf(file(manifest(100 * MB, 300 * MB, 280 * MB)), false)).toBe(120 * MB); // over 50 MB of drawings: the browser keeps the text history only
    expect(await keptBytesOf(file(manifest(100 * MB, 300 * MB, 50 * MB)), false)).toBe(400 * MB); // at the threshold it keeps all of it
    // a file without that line (cut short, or of an older version): counted whole
    const cut = file(`${hello}{"kind":"page","page":`);
    expect(await keptBytesOf(cut, false)).toBe(cut.size);
    // and the screen asks for that much, not three times the whole file
    mocks.readiness.mockResolvedValue({ ready: false, code: "join_history_missing", kind: null, holds: NONE });
    mocks.storage.mockResolvedValue({ persistent: true, usedBytes: 0, quotaBytes: roomNeeded(300) + 1 });
    join.mockResolvedValue(taken({ pages: 0 }));
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await screen.findByRole("heading", { name: "This device has no earlier versions" });
    await choose(user, manifest(10 ** 9, 300, 0));
    await waitFor(() => expect(join).toHaveBeenCalled());
  });

  it("a device that has its notes and too little room is told so on its own screen, never the empty device's", async () => {
    mocks.readiness.mockResolvedValue({ ready: false, code: "join_history_missing", kind: null, holds: NONE });
    mocks.storage.mockResolvedValue({ persistent: true, usedBytes: 0, quotaBytes: 10 });
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not have room/);
    expect(screen.getByRole("heading").textContent).toBe("This device has no earlier versions");
    expect(join).not.toHaveBeenCalled();
  });

  it("warns when the browser has not promised to keep its data", async () => {
    mocks.storage.mockResolvedValue({ persistent: false, usedBytes: 0, quotaBytes: 10 ** 12 });
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    expect(await screen.findByText(/has not promised to keep this site's data/)).toBeTruthy();
  });
});

describe("taking the file in", () => {
  it("shows what has been read, then says the new device holds everything up to the moment the file was made and reloads", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let finish!: (result: JoinFileResult) => void;
      join.mockImplementation((_file, progress) => { progress(50, 100); return new Promise((resolve) => { finish = resolve; }); });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
      await choose(user);
      expect((await screen.findByRole("status")).textContent).toMatch(/50% of the file read/);
      expect(readBringState()).toBe("joining"); // a page killed now finds this at the next start
      finish(taken());
      expect((await screen.findByText(/everything up to the moment the file was made/)).textContent).toMatch(/do not update each other yet/);
      expect(readBringState()).toBeNull();
      await vi.advanceTimersByTimeAsync(4000);
      expect(mocks.reload).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  // What each refusal says. The detail is the backend's English; it must never reach the screen.
  const table: Array<[string, JoinFileResult, RegExp]> = [
    ["the digests differ", refused("join_digest_mismatch", "the copy differs from the source in: content_nodes (rows, +3)"), /doesn't match the original/],
    ["the file is cut short", refused("join_incomplete", "the upload ended before the end of the snapshot"), /file is cut short/],
    ["the other device stopped", refused("join_source_failed"), /other device stopped before the file was finished/],
    ["a line is not a message", refused("join_bad_line", "a line of the upload is not a message", 422), /not a file Onden made, or it is damaged/],
    ["a file of another version", refused("join_column_not_carried", "a column a snapshot does not carry: content_nodes.x", 422), /holds something this version can't take in/],
    ["a file with another data shape", refused("join_data_shape", "the pages are of data shape 3", 422), /different version of Onden/],
    ["the person is not the owner", refused("join_person_not_owner"), /doesn't own the workspace/],
    ["no sign-in here", refused("join_no_login"), /could not open the notes after they are added/],
    ["the file was made on this very device", refused("join_from_self", null, 422), /made on this very device/],
    ["a join already ran", refused("join_already_done"), /already holds notes brought from another device/],
    ["not kept by the browser's storage", refused("join_not_kept", null, 507), /no room to keep the notes/],
    ["the worker gave no code", refused(null, null, 0), /could not be read all the way/],
  ];
  it.each(table)("%s: a plain sentence, nothing was kept, and the way on", async (_name, result, sentence) => {
    join.mockResolvedValue(result);
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(sentence);
    expect(alert.textContent).not.toMatch(/snapshot|content_nodes|_|upload/);
    // only where the backend gave the join up is the copy said to be empty; after a join that was already done, already running, or not allowed, nothing is claimed
    const claimsEmpty = !["join_person_not_owner", "join_no_login", "join_already_done", "join_in_progress"].includes(String(result.ok ? "" : result.error));
    expect(screen.queryByText("Nothing was kept: this device is empty again.") !== null).toBe(claimsEmpty);
    expect(readBringState()).toBe("pending");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this device on its own" })).toBeTruthy();
  });

  it("a copy with content of its own is refused: the backend is asked what it holds and the screen says it in counts, and nothing is erased without asking", async () => {
    join.mockResolvedValue(refused("join_not_empty", "this database already holds content of its own (own_notes)"));
    mocks.readiness.mockResolvedValueOnce(EMPTY).mockResolvedValue(HOLDING); // empty when the screen opened, holding something when the file is refused
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    expect(await screen.findByText(/already has content of its own, so it can't take the file without erasing it: 3 notes, 2 in the trash, 1 tags/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/own_notes|join_/);
    mocks.confirm.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Erase everything on this device and continue" }));
    expect(mocks.erase).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Erase everything on this device and continue" }));
    await waitFor(() => expect(mocks.erase).toHaveBeenCalledTimes(1));
    expect(String(mocks.confirm.mock.calls.at(-1)![0])).toMatch(/Right now that is: 3 notes, 2 in the trash, 1 tags\./);
    expect(readBringState()).toBe("pending");
    expect(mocks.reload).toHaveBeenCalled();
  });

  it("a copy used for more than notes (nothing counted) says that, not a count", async () => {
    join.mockResolvedValue(refused("join_not_empty", "x"));
    mocks.readiness.mockResolvedValueOnce(EMPTY).mockResolvedValue({ ...HOLDING, kind: "ai_connection", holds: NONE });
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    expect(await screen.findByText(/used for more than notes/)).toBeTruthy();
  });

  it.each(["join_incomplete", "join_not_kept", "join_already_done"])("after %s every way out starts again from what is saved: a reload, never the app on the memory copy", async (code) => {
    join.mockResolvedValue(refused(code, null, code === "join_not_kept" ? 507 : 409));
    const onLeave = vi.fn();
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={onLeave} />);
    await choose(user);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(readBringState()).toBe("pending");
    await user.click(screen.getByRole("button", { name: "Use this device on its own" }));
    expect(mocks.reload).toHaveBeenCalledTimes(2);
    expect(onLeave).not.toHaveBeenCalled();
    expect(readBringState()).toBeNull(); // the reload opens the app
  });

  it("a worker that ends before it answers is a cut-off join: the page reloads with the marker still saying so, never waits for ever", async () => {
    join.mockRejectedValue(new Error("the worker ended"));
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    expect(readBringState()).toBe("joining");
  });

  it("the whole file read says it is putting the notes in order, not a percentage that stays at 99", async () => {
    let finish!: (result: JoinFileResult) => void;
    join.mockImplementation((_file, progress) => { progress(100, 100); return new Promise((resolve) => { finish = resolve; }); });
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    expect((await screen.findByRole("status")).textContent).toMatch(/whole file is read. Putting your notes in order/);
    finish(refused("join_incomplete"));
  });
});

describe("a copy that is not empty when this screen opens", () => {
  it("a copy a join already filled (the page closed before it heard) says its notes are here and clears the marker, never 'nothing was kept'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      writeBringState("joining");
      mocks.readiness.mockResolvedValue({ ready: false, code: "join_already_done", kind: null, holds: { ...NONE, own_notes: 40 } });
      render(<BringNotes client={client} interrupted onLeave={() => {}} />);
      expect(await screen.findByText("Your notes are here")).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/Nothing was kept|Erase/);
      expect(readBringState()).toBeNull();
      await vi.advanceTimersByTimeAsync(4000);
      expect(mocks.reload).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("a copy a join filled, opened again, says what of the earlier versions the database holds (not a fixed 'all of them')", async () => {
    mocks.readiness.mockResolvedValue({ ready: false, code: "join_already_done", kind: null, holds: NONE, history: { scope: "body", leftOut: 2 } });
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    expect(await screen.findByText(/earlier versions of handwriting were left out/)).toBeTruthy();
    expect(screen.getByText(/2 earlier versions were not complete on your other device/)).toBeTruthy();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("the backend's counts are what the screen says", async () => {
    mocks.readiness.mockResolvedValue(HOLDING);
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    expect(await screen.findByText(/3 notes, 2 in the trash, 1 tags/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Erase everything on this device and continue" })).toBeTruthy();
  });

  it("a backend that cannot answer leaves the choice of the file open (the join itself still refuses)", async () => {
    mocks.readiness.mockRejectedValue(new Error("offline"));
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    expect(await screen.findByRole("button", { name: "Choose the file from your other device…" })).toBeTruthy();
  });
});

// Review of PR #1988, round 1, point 1: the notes in and their earlier versions not all in is never "done"; there is always a way on (the same file again)
// and a way out (stop waiting), and no step lets one think everything came over when it did not.
describe("the notes came, their earlier versions did not all come", () => {
  it("says so plainly, does not open the notes by itself, and the same file again brings in the rest", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      join.mockResolvedValueOnce(taken({ history: "arriving" }));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
      await choose(user);
      expect((await screen.findByRole("heading")).textContent).toMatch(/earlier versions are not all here/);
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/All your notes came over/);
      expect(text).toMatch(/does not yet have every earlier version/);
      expect(text).not.toMatch(/everything up to the moment the file was made/);
      expect(text).not.toMatch(/snapshot|ndjson|json|stamp|join_|_/i);
      expect(readBringState()).toBeNull(); // the notes ARE here: a later start is not "nothing was kept"
      await vi.advanceTimersByTimeAsync(4000);
      expect(mocks.reload).not.toHaveBeenCalled();
      join.mockResolvedValueOnce(taken());
      await user.click(screen.getByRole("button", { name: "Choose the same file again…" }));
      await choose(user);
      expect(await screen.findByText(/everything up to the moment the file was made, with the notes' earlier versions/)).toBeTruthy();
      expect(join).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("a refusal of the earlier versions is said in words with a way on, and the notes are said to be here", async () => {
    join.mockResolvedValue(taken({ history: "arriving", historyRefused: "join_history_hash" }));
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/damaged on the way/);
    expect(alert.textContent).toMatch(/Your notes are here/);
    expect(alert.textContent).not.toMatch(/join_|_|hash/);
    expect(screen.queryByText("Nothing was kept: this device is empty again.")).toBeNull();
  });

  it("any refusal once the notes are in (a file cut in a line, another file): the screen asks the database and says the notes are here, never 'not brought over'", async () => {
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    for (const [status, code] of [[422, "join_bad_line"], [409, "join_history_other_file"], [409, null]] as const) {
      mocks.readiness.mockResolvedValue(EMPTY);
      join.mockImplementationOnce(async () => { mocks.readiness.mockResolvedValue({ ready: false, code: "join_history_arriving", kind: null, holds: NONE }); return refused(code, null, status); });
      await choose(user);
      expect((await screen.findByRole("heading")).textContent, String(code)).toBe("Your notes are here, their earlier versions are not all here");
      expect(document.body.textContent, String(code)).not.toMatch(/were not brought over|Nothing was kept|this device is empty/);
      expect(screen.getByRole("alert").textContent, String(code)).not.toMatch(/join_|json/i);
      expect(readBringState(), String(code)).toBeNull();
    }
  });

  it("a refusal before the notes are in still says nothing was kept: the database is the empty one", async () => {
    join.mockResolvedValue(refused("join_bad_line", null, 422));
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    expect((await screen.findByRole("heading")).textContent).toBe("The notes were not brought over");
    expect(document.body.textContent).toMatch(/Nothing was kept: this device is empty again/);
  });

  it("stopping the wait asks first, keeps the notes, and says where the earlier versions are", async () => {
    join.mockResolvedValue(taken({ history: "arriving" }));
    mocks.stopWaiting.mockResolvedValue({ removed: 4 });
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    mocks.confirm.mockResolvedValueOnce(false);
    await user.click(await screen.findByRole("button", { name: "Stop waiting for the earlier versions" }));
    expect(mocks.stopWaiting).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop waiting for the earlier versions" }));
    expect(await screen.findByText(/no longer waits for the earlier versions/)).toBeTruthy();
    expect(mocks.stopWaiting).toHaveBeenCalledTimes(1);
    expect(String(mocks.confirm.mock.calls[0]![0])).toMatch(/Your notes stay as they are/);
  });

  it("opened again on such a copy, the screen comes back to the same question", async () => {
    mocks.readiness.mockResolvedValue({ ready: false, code: "join_history_arriving", kind: null, holds: NONE });
    render(<BringNotes client={client} interrupted onLeave={() => {}} />);
    expect((await screen.findByRole("heading")).textContent).toMatch(/earlier versions are not all here/);
    expect(screen.queryByText(/Nothing was kept/)).toBeNull();
    expect(screen.getByRole("button", { name: "Choose the same file again…" })).toBeTruthy();
  });

  it("all of it came except what this browser does not keep, and what the other device did not hold whole: each is said, and the screen waits", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      join.mockResolvedValue(taken({ historyScope: "body", historyLeftOut: 2 }));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
      await choose(user);
      expect(await screen.findByText(/earlier versions of handwriting were left out/)).toBeTruthy();
      expect(screen.getByText(/2 earlier versions were not complete on your other device/)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(4000);
      expect(mocks.reload).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("the way in from Settings on such a copy never offers to erase it: it goes on with the same file", async () => {
    mocks.readiness.mockResolvedValue({ ready: false, code: "join_history_arriving", kind: null, holds: { ...NONE, own_notes: 12 } });
    const user = userEvent.setup();
    render(<BringEntry client={client} onClose={() => {}} />);
    expect(await screen.findByText(/their earlier versions have not all arrived/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Erase/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalled());
    expect(mocks.erase).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(readBringState()).toBe("pending");
  });
});

// The owner's decision of 2026-11-23 (PR #1988 round 1 point 8): a copy that has its notes and none of their earlier versions says so, and a file of the device the
// notes came from brings only those in; the notes are never in question on these screens (no erase, no "nothing was kept").
describe("a copy whose notes have no earlier versions", () => {
  const NO_HISTORY = { ready: false, code: "join_history_missing", kind: null, holds: NONE };

  it("says so in words, and what to do; it never offers to erase", async () => {
    mocks.readiness.mockResolvedValue(NO_HISTORY);
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    expect((await screen.findByRole("heading")).textContent).toBe("This device has no earlier versions");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Your notes are here, but this device has none of their earlier versions/);
    expect(text).toMatch(/Only the earlier versions are taken from it: your notes here are not changed/);
    expect(text).toMatch(/a file for another device cannot be made from this one: it would carry notes without their history/);
    expect(text).not.toMatch(/snapshot|json|join_|Erase|Nothing was kept/i);
    expect(screen.getByRole("button", { name: "Choose the file from your other device…" })).toBeTruthy();
  });

  it("a file that brings them says that only the earlier versions came, not that everything did", async () => {
    mocks.readiness.mockResolvedValue(NO_HISTORY);
    join.mockResolvedValue(taken({ pages: 0 }));
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await choose(user);
    expect(await screen.findByText("The earlier versions of your notes are here now. Your notes themselves were not changed.")).toBeTruthy();
    expect(screen.queryByText(/everything up to the moment the file was made/)).toBeNull();
  });

  it("a file of another device, or one that ended before them, leaves the same screen with the reason; nothing is said to be lost", async () => {
    mocks.readiness.mockResolvedValue(NO_HISTORY);
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    join.mockResolvedValueOnce(refused("join_history_other_source"));
    await choose(user);
    expect((await screen.findByRole("alert")).textContent).toMatch(/made on another device than the one this device took its notes from/);
    expect((await screen.findByRole("heading")).textContent).toBe("This device has no earlier versions");
    expect(document.body.textContent).not.toMatch(/Nothing was kept|were not brought over/);
    join.mockResolvedValueOnce(taken({ pages: 0, history: "missing", historyRefused: "join_incomplete" }));
    await choose(user);
    expect((await screen.findByRole("alert")).textContent).toMatch(/cut short/);
    expect((await screen.findByRole("heading")).textContent).toBe("This device has no earlier versions");
  });

  it("the way in from Settings goes on to that screen without erasing anything", async () => {
    mocks.readiness.mockResolvedValue({ ...NO_HISTORY, holds: { ...NONE, own_notes: 12 } });
    const user = userEvent.setup();
    render(<BringEntry client={client} onClose={() => {}} />);
    expect(await screen.findByText(/has no earlier versions of its notes. Continue to choose a file made on the device the notes came from/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Erase/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalled());
    expect(mocks.erase).not.toHaveBeenCalled();
    expect(readBringState()).toBe("pending");
  });

  it("after stopping waiting, the screen says a file cannot be made from this device until they are brought in", async () => {
    mocks.readiness.mockResolvedValue({ ready: false, code: "join_history_arriving", kind: null, holds: NONE });
    mocks.stopWaiting.mockResolvedValue({ removed: 2 });
    const user = userEvent.setup();
    render(<BringNotes client={client} interrupted={false} onLeave={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Stop waiting for the earlier versions" }));
    expect(await screen.findByText(/no longer waits for the earlier versions/)).toBeTruthy();
    expect(screen.getByText(/Until they are brought in, a file for another device cannot be made from this one/)).toBeTruthy();
    expect(String(mocks.confirm.mock.calls[0]![0])).toMatch(/a file from it can bring them in later. Until then this device can't make a file for another one/);
  });
});

describe("the way in from Settings while the app is open", () => {
  it("a copy with content of its own: counts and one erase question; nothing happens before the answer", async () => {
    mocks.readiness.mockResolvedValue(HOLDING);
    mocks.confirm.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<BringEntry client={client} onClose={() => {}} />);
    expect(await screen.findByText(/already has content of its own: 3 notes, 2 in the trash, 1 tags/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Erase everything and continue" }));
    expect(mocks.erase).not.toHaveBeenCalled();
    expect(readBringState()).toBeNull();
    mocks.confirm.mockResolvedValue(true);
    await user.click(screen.getByRole("button", { name: "Erase everything and continue" }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalled());
    expect(mocks.erase).toHaveBeenCalledTimes(1);
    expect(String(mocks.confirm.mock.calls[0]![0])).toMatch(/everything on this device, including the trash, tags and added files/);
    expect(readBringState()).toBe("pending");
  });

  it("a copy with nothing on it is not erased: the choice is remembered and the page reloads", async () => {
    const user = userEvent.setup();
    render(<BringEntry client={client} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalled());
    expect(mocks.erase).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(readBringState()).toBe("pending");
  });

  it("a join that is running is said, and nothing is offered", async () => {
    mocks.readiness.mockResolvedValue({ ready: false, code: "join_in_progress" });
    render(<BringEntry client={client} onClose={() => {}} />);
    expect(await screen.findByText(/already being brought to this device/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Erase|Continue/ })).toBeNull();
  });
});
