// The spaces list in the REAL local-copy worker (sql.js): what lib/spaces.ts stores is read back after a reload, and an
// access-revoked wipe drops it with the rest of the account's copy. (A schema change drops it too:
// mirrorSchemaVersion.test.ts.)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWorker, reopen, rpc } from "./helpers/localDbWorkerHarness";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../lib/indexedDbStorage", () => ({
  idbLoad: async () => disk.bytes,
  idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; },
}));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

const spaces = [{ id: "personal-1", kind: "personal", name: "me", permission: "edit" }, { id: "team-1", kind: "shared", name: "Team", permission: "view" }];

beforeEach(async () => {
  disk.bytes = null;
  await openWorker();
});

describe("the kept spaces list", () => {
  it("is none on a new copy, and survives a reload once stored", async () => {
    expect(await rpc("loadSpaces")).toBeNull();
    await rpc("storeSpaces", spaces);
    await reopen();
    expect(await rpc("loadSpaces")).toEqual(spaces);
  });

  it("a newer answer replaces it", async () => {
    await rpc("storeSpaces", spaces);
    await rpc("storeSpaces", [{ id: "personal-2", kind: "personal" }]);
    expect(await rpc("loadSpaces")).toEqual([{ id: "personal-2", kind: "personal" }]);
  });

  it("goes with the wipe when access is revoked", async () => {
    await rpc("storeSpaces", spaces);
    await rpc("wipeWorkspaceMirror");
    expect(await rpc("loadSpaces")).toBeNull();
  });
});
