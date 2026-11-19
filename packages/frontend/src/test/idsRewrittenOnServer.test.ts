// Migration 201 changes the ids of the capture tag and of the default and personal spaces on the SERVER and raises the workspace's
// membership epoch. A device that still holds the old ones must end with the new ones only: no second 収件匣 tag, no stale space, and
// personalSpaceId() is the new id (docs/architecture/proposals/distributed-ready-2026-11-12.md §4.5).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));

import { api } from "../lib/api";
import { reconcileMembership, type MembershipPage, type MembershipProjection, type ReconcileDeps } from "../lib/data/membershipReconcile";
import { loadedSpaces, noteMembershipEpoch, personalSpaceId, refreshSpaces, resetSpacesForTest } from "../lib/spaces";

const OLD_TAG = "00000000-0000-4000-8000-0000000000a1";
const NEW_TAG = "00000000-0000-5000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-0000000000b1";
const OLD_PERSONAL = "00000000-0000-4000-8000-0000000000c1";
const NEW_PERSONAL = "00000000-0000-5000-8000-0000000000c1";
const space = (id: string, kind: string) => ({ id, name: kind, kind, is_default: kind === "shared", owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true });

describe("a device that held ids the server has since rewritten", () => {
  beforeEach(() => { vi.mocked(api).mockReset(); resetSpacesForTest(); });

  it("re-reading what it may see drops the old tag and takes the new one: the note stays, nothing is held twice", async () => {
    const serverIds = [NEW_TAG, NOTE].sort();
    const fetchPage = vi.fn(async (): Promise<MembershipPage> => ({ ids: serverIds, next_cursor: null, epoch: 9, event_cursor: "100" }));
    const isolateRevoked = vi.fn(async () => {});
    const applied: MembershipProjection[] = [];
    const deps: ReconcileDeps = {
      startEpoch: 9, fetchPage,
      getLocalKnown: async () => [OLD_TAG, NOTE], // what the device holds: the capture tag under its old id, and a note
      isolateRevoked,
      fetchProjection: async (ids, epoch) => ({ epoch, event_cursor: "100", nodes: ids.map((id) => ({ id })) as MembershipProjection["nodes"], attributes: { upsert: [], delete: [] }, edges: [], tasks: [] }),
      applyProjection: async (value) => { applied.push(value); },
      saveEpoch: async () => {},
    };
    expect(await reconcileMembership(deps)).toMatchObject({ status: "done", revoked: 1, granted: 1 });
    expect(isolateRevoked).toHaveBeenCalledWith([OLD_TAG], expect.objectContaining({ event_cursor: "100" }));
    expect(applied.flatMap((p) => p.nodes.map((n) => n.id))).toEqual([NEW_TAG]);
  });

  it("when the epoch moves the spaces are read again, and the personal space is the new id", async () => {
    const apiMock = vi.mocked(api);
    let current = OLD_PERSONAL;
    apiMock.mockImplementation(async (path: string) => (path === "/api/spaces" ? { spaces: [space(current, "personal")], is_owner: true } : {}));
    noteMembershipEpoch(4);
    await refreshSpaces();
    expect(personalSpaceId()).toBe(OLD_PERSONAL);
    current = NEW_PERSONAL; // the server's migration ran
    noteMembershipEpoch(5);
    await vi.waitFor(() => expect(personalSpaceId()).toBe(NEW_PERSONAL));
    expect(loadedSpaces().map((s) => s.id)).toEqual([NEW_PERSONAL]);
  });
});
