// R1 (dup-patterns-2026-10-30-be): canSeeTag is async; assertVisibleTag once
// forgot the `await`, so a tag the actor cannot see still passed the check.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { canSeeTag } = vi.hoisted(() => ({ canSeeTag: vi.fn() }));
vi.mock("../../db.js", () => ({ q: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })), getWorkspaceId: async () => "ws" }));
vi.mock("../../services/readPolicy.js", async (original) => ({ ...(await original<typeof import("../../services/readPolicy.js")>()), canSeeTag }));

import { personalSettings } from "./service.js";
import type { ActorCtx } from "../../types.js";

const actor: ActorCtx = { id: "a", name: "A", role: "admin", type: "human" };

describe("review tag visibility", () => {
  beforeEach(() => canSeeTag.mockReset());

  it("a tag the actor cannot see is a 404", async () => {
    canSeeTag.mockResolvedValue(false);
    await expect(personalSettings(actor, "tag-1")).rejects.toMatchObject({ status: 404 });
  });

  it("a visible tag passes the check", async () => {
    canSeeTag.mockResolvedValue(true);
    await expect(personalSettings(actor, "tag-1")).resolves.toBeNull();
  });
});
