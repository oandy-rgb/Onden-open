// "The server could not be reached" versus "the server answered": the one judgement boot and reconnect share
// (lib/data/writeErrors.ts isServerUnreachable, read by syncEngine's SyncResult.unreachable). Owner decision 2026-11-15:
// unreachable is offline; only an answer from the server can lock the workspace.
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { isServerUnreachable } from "../lib/data/writeErrors";

const answer = (status: number, error?: string) => new ApiError(status, error ? JSON.stringify({ error }) : "<html>gateway</html>");

describe("isServerUnreachable", () => {
  it.each([502, 503, 504])("a bare gateway %i (no server code) is unreachable", (status) => {
    expect(isServerUnreachable(answer(status))).toBe(true);
  });
  it("a network failure and a timeout are unreachable", () => {
    expect(isServerUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isServerUnreachable(Object.assign(new Error("deadline"), { name: "TimeoutError" }))).toBe(true);
  });
  it.each([[401, "membership_removed"], [401, "unauthorized"], [403, "forbidden"], [500, "internal"], [503, "workspace_busy"]])(
    "the server's own answer %i %s is not unreachable", (status, code) => {
      expect(isServerUnreachable(answer(status, code))).toBe(false);
    });
});
