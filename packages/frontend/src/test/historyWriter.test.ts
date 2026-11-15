// History's writes (lib/data/noteHistoryWriter.ts): an undo / redo / rewind is one online action whose
// answer is the server's report; a lost report is not a failure and not a guess.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { writersFor } from "../lib/data";
import { setLocalePref } from "../lib/i18n";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: apiMock }));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: async () => [] }));

const toasts: Array<[string, string | undefined]> = [];
const history = () => writersFor({ online: true, notify: (message, kind) => { toasts.push([message, kind]); } }).history;

beforeEach(() => { apiMock.mockReset(); toasts.length = 0; setLocalePref("en"); });

describe("historyWriter", () => {
  it("sends the chosen notes with an Idempotency-Key and returns the server's report", async () => {
    apiMock.mockResolvedValue({ undone: ["n1"], conflicts: [], skipped: [] });
    expect(await history().undoAgentRun("run 1", ["n1"])).toEqual({ undone: ["n1"], conflicts: [], skipped: [] });
    const [path, init] = apiMock.mock.calls[0]!;
    expect(path).toBe("/api/history/agent-runs/run%201/undo");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ node_ids: ["n1"] });
    expect(init.headers["Idempotency-Key"]).toBeTruthy();
  });

  it("a retry after a lost response is answered 'deduped': undefined, said once, no counts guessed", async () => {
    apiMock.mockResolvedValue({ deduped: true });
    expect(await history().undoRewind("rw-1", ["n1"])).toBeUndefined();
    expect(toasts).toEqual([["The change is saved. Refresh to load the latest details.", "info"]]);
  });

  it("a failed write is retried with the same key; a refusal throws", async () => {
    const writer = history();
    apiMock.mockRejectedValueOnce(new ApiError(503, "Unavailable")).mockResolvedValueOnce({ undone: ["n1"], conflicts: [], kept: [], skipped: [] });
    await expect(writer.undoRewind("rw-1", ["n1"])).rejects.toBeInstanceOf(ApiError);
    await writer.undoRewind("rw-1", ["n1"]);
    const keys = apiMock.mock.calls.map(([, init]) => init.headers["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("rewind and redo go to their own endpoints", async () => {
    apiMock.mockResolvedValue({});
    const writer = history();
    await writer.rewindWorkspace({ t: "2026-10-26T00:00:00.000Z", restore_ids: ["a"], undelete_ids: [], delete_ids: [] });
    await writer.redoAgentRun("run-1", ["n1"]);
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual(["/api/history/rewind", "/api/history/agent-runs/run-1/redo"]);
  });
});
