import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A removed member's 401 (membership_removed) is not "offline": api() reports it
// once to the app's handler, which wipes the local copy and shows a notice.
// A plain signed-out 401 or a network error must not trigger it.

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

it("reports membership_removed to the handler exactly once", async () => {
  const { api } = await import("../lib/api");
  const { onAccessRevoked } = await import("../lib/accessRevoked");
  const handler = vi.fn();
  onAccessRevoked(handler);
  respond(401, { error: "membership_removed" });
  await expect(api("/api/bootstrap")).rejects.toMatchObject({ status: 401, code: "membership_removed" });
  await expect(api("/api/sync")).rejects.toMatchObject({ status: 401 });
  expect(handler).toHaveBeenCalledTimes(1);
});

it("a handler registered after the refusal still runs (boot ordering)", async () => {
  const { api } = await import("../lib/api");
  const { onAccessRevoked } = await import("../lib/accessRevoked");
  respond(401, { error: "membership_removed" });
  await expect(api("/api/bootstrap")).rejects.toBeTruthy();
  const late = vi.fn();
  onAccessRevoked(late);
  expect(late).toHaveBeenCalledTimes(1);
});

it("other 401s and network failures are not a revocation", async () => {
  const { api } = await import("../lib/api");
  const { onAccessRevoked } = await import("../lib/accessRevoked");
  const handler = vi.fn();
  onAccessRevoked(handler);
  respond(401, { error: "unauthorized" });
  await expect(api("/api/bootstrap")).rejects.toMatchObject({ status: 401 });
  respond(401, { error: "account_changed" });
  await expect(api("/api/bootstrap")).rejects.toMatchObject({ status: 401 });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await expect(api("/api/bootstrap")).rejects.toBeInstanceOf(TypeError);
  expect(handler).not.toHaveBeenCalled();
});
