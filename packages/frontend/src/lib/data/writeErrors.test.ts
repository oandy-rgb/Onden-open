import { describe, it, expect } from "vitest";
import { ApiError } from "../api";
import { classifyWriteFailure, isServerUnreachable, writeFailureMessage } from "./writeErrors";

describe("isServerUnreachable", () => {
  it("a failed fetch, a deadline and the gateway's 502/503/504 did not reach the server", () => {
    expect(isServerUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isServerUnreachable(new DOMException("Read timed out", "TimeoutError"))).toBe(true);
    for (const status of [502, 503, 504]) expect(isServerUnreachable(new ApiError(status, "<html>Bad Gateway</html>"))).toBe(true);
  });

  it("an answer from the backend, a cancelled request or another failure did", () => {
    for (const status of [400, 401, 403, 404, 408, 409, 425, 429, 500]) expect(isServerUnreachable(new ApiError(status, "x"))).toBe(false);
    // The backend's own 503/502 carry its JSON code (a reachable server, not a gateway).
    expect(isServerUnreachable(new ApiError(503, '{"error":"module_not_imported"}'))).toBe(false);
    expect(isServerUnreachable(new ApiError(502, '{"error":"upstream_unavailable"}'))).toBe(false);
    expect(isServerUnreachable(new DOMException("Read cancelled", "AbortError"))).toBe(false);
    expect(isServerUnreachable(new Error("membership reconciliation exhausted"))).toBe(false);
    expect(isServerUnreachable(undefined)).toBe(false);
  });

  it("is narrower than retryable: a 500 or a 429 retries but the server was reached", () => {
    expect(classifyWriteFailure(new ApiError(500, "boom"))).toBe("retryable");
    expect(classifyWriteFailure(new ApiError(429, "slow"))).toBe("retryable");
    expect(classifyWriteFailure(new ApiError(502, "bad gateway"))).toBe("retryable");
    expect(classifyWriteFailure(new TypeError("Failed to fetch"))).toBe("retryable");
  });
});

describe("426 client_too_old / server_too_old: a version mismatch, not a rejection", () => {
  const refused = () => new ApiError(426, '{"error":"client_too_old"}');

  it("waits for an update: never a rejection (the queue keeps it), never a timer retry, and the server was reached", () => {
    expect(classifyWriteFailure(refused())).toBe("waitForUpdate");
    expect(classifyWriteFailure(new ApiError(426, '{"error":"server_too_old"}'))).toBe("waitForUpdate");
    expect(isServerUnreachable(refused())).toBe(false);
  });

  it("tells the person in plain words, with no code", () => {
    const message = writeFailureMessage(refused());
    expect(message).toBe("This screen is an old version. Reload it before you edit; what you just typed is still here.");
    expect(message).not.toMatch(/client_too_old|426/);
    const server = writeFailureMessage(new ApiError(426, '{"error":"server_too_old"}'));
    expect(server).toBe("This server needs to be updated before your changes can be sent. They are kept on this device and will be sent once it is.");
    expect(server).not.toMatch(/server_too_old|426/);
  });
});

describe("503 workspace_busy: another write held the workspace lock", () => {
  const busy = () => new ApiError(503, '{"error":"workspace_busy","retry_after_seconds":5}');

  it("retries later: the server was reached and nothing was refused", () => {
    expect(classifyWriteFailure(busy())).toBe("retryable");
    expect(isServerUnreachable(busy())).toBe(false);
  });

  it("tells the person in plain words that it will be tried again, with no code", () => {
    const message = writeFailureMessage(busy());
    expect(message).toBe("Other changes are being saved right now. Yours will be tried again automatically in a moment.");
    expect(message).not.toMatch(/workspace_busy|503/);
  });
});
