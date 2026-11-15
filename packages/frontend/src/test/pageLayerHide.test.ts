// Page text boxes and pictures: when the page is hidden while the layer's save is still on the wire, the save
// is not lost: it is kept as a recovery write under its own idempotency key, so the next page load replays it
// (and the server deduplicates it if the request did arrive). So pageLayerWriter needs no keepalive of its own.
import { bindAccountStorage } from "../lib/accountStorage";
import { setAppState } from "../lib/appStore";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  catchUpWithOtherTabs: vi.fn(), getOldestPendingWriteAt: vi.fn(), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(async () => []), clearPendingWrite: vi.fn(),
  bumpPendingWriteAttempt: vi.fn(), rejectPendingWrite: vi.fn(), storeRejectedWrite: vi.fn(), getRejectedWrites: vi.fn(async () => []), dismissRejectedWrite: vi.fn(),
  upsertAttribute: vi.fn(async () => {}), getNodeAttributeRecord: vi.fn(async () => null),
}));
import { savePageLayer } from "../lib/data/pageLayerWriter";
import { getRecoveryWrites } from "../lib/data/writeRecovery";

beforeEach(() => { bindAccountStorage("unit-test-account", ""); setAppState({ online: true }); mocks.api.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

it("a page-layer save still on the wire when the page is hidden is kept for replay", async () => {
  mocks.api.mockReturnValue(new Promise(() => {})); // the request never answers: the page is going away
  const value = JSON.stringify([{ id: "a", text: "Hello" }]);
  savePageLayer("note-1", "page_text", value, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.dispatchEvent(new Event("pagehide"));
  expect(mocks.api).toHaveBeenCalledTimes(1); // it is on the wire
  const kept = getRecoveryWrites().find((write) => write.path === "/api/nodes/note-1/attributes/page_text");
  expect(kept).toMatchObject({ method: "PUT", exited: true, idemKey: expect.any(String) });
  expect(JSON.parse(kept!.body!)).toMatchObject({ value });
});
