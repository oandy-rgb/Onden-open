// The browser version taking a file from another device: BringNotes.tsx, BringEntry.tsx, bringNotes.ts.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JoinFileResult, WorkerClient } from "../lib/browserAppWorker";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(), erase: vi.fn(), reload: vi.fn(), confirm: vi.fn(),
  storage: vi.fn(),
}));
vi.mock("../lib/browserAppBridge", () => ({ eraseBrowserCopy: mocks.erase }));
vi.mock("../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/data")>()), reads: { workspace: { snapshotReadiness: mocks.readiness } } }));
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), reloadPage: mocks.reload }));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("../lib/storagePersist", () => ({ storageStatus: mocks.storage }));

import BringNotes from "../browserApp/BringNotes";
import BringEntry from "../browserApp/BringEntry";
import { readBringState, writeBringState } from "../browserApp/bringNotes";

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
      finish({ ok: true, pages: 3, rows: 120 });
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
