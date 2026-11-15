// W30: a plain tag (no schema) is created by anyone who can write somewhere,
// not by a read-only token. (A role change doesn't touch the readable set —
// reads follow space membership — so it rightly doesn't bump the epoch;
// membershipEpoch.integration.test.ts pins that.)
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { resolveOrCreateTagPath } from "../services/tagHierarchy.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));

describe.skipIf(!isTestDb)("tag creation authority and role-change epoch (DB)", () => {
  let owner: ActorCtx = { id: `tca-owner-${randomUUID().slice(0, 6)}`, name: "Owner", role: "admin", type: "human" };
  let reader: ActorCtx = { id: `tca-token-${randomUUID().slice(0, 6)}`, name: "Reader token", role: "viewer", type: "agent" };
  let member: ActorCtx = { id: `tca-member-${randomUUID().slice(0, 6)}`, name: "Member", role: "editor", type: "human" };

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Tag authority', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, owner);
    member = await persistActor(ws, member);
    reader = await persistActor(ws, reader);
    reader = { ...reader, tokenScope: { tokenId: `tok-${randomUUID().slice(0, 6)}`, allowedTools: null, access: "read", expiresAt: null } } as ActorCtx;
  });

  it("a read-only token can't create a tag; the owner can", async () => {
    await expect(resolveOrCreateTagPath(ws, `ro-${randomUUID().slice(0, 6)}`, reader)).rejects.toThrow();
    const { leafId } = await resolveOrCreateTagPath(ws, `ok-${randomUUID().slice(0, 6)}`, owner);
    expect(leafId).toMatch(/^[0-9a-f-]{36}$/);
  });

});
