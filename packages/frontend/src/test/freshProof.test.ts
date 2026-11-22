// lib/data/freshProof.ts: the ticket for "it is me, just now", and a refusal that shows only in the person's words.
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ postRead: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), postRead: api.postRead }));

import { ApiError } from "../lib/api";
import { freshProof } from "../lib/data/freshProof";

describe("freshProof.issue", () => {
  it("sends the purpose and the evidence and resolves the ticket", async () => {
    api.postRead.mockResolvedValue({ ticket: "abc", expires_in_seconds: 120 });
    await expect(freshProof.issue("snapshot_export", { kind: "password", password: "pw" })).resolves.toBe("abc");
    expect(api.postRead).toHaveBeenCalledWith("/api/fresh-proof", { purpose: "snapshot_export", evidence: { kind: "password", password: "pw" } });
  });

  it("a refusal keeps its code and status but not the server's English detail", async () => {
    api.postRead.mockRejectedValue(new ApiError(403, JSON.stringify({ error: "fresh_proof_locked", detail: "locked for 15 minutes (attempt 6)" })));
    const failure = (await freshProof.issue("snapshot_export", { kind: "acknowledgement" }).then(() => null, (error: unknown) => error)) as ApiError;
    expect(failure.status).toBe(403);
    expect(failure.code).toBe("fresh_proof_locked");
    expect(failure.message).not.toMatch(/attempt|15 minutes/);
  });

  it("anything that is not a refusal (no connection) passes through unchanged", async () => {
    const offline = new TypeError("Failed to fetch");
    api.postRead.mockRejectedValue(offline);
    await expect(freshProof.issue("snapshot_export", { kind: "acknowledgement" })).rejects.toBe(offline);
  });
});
