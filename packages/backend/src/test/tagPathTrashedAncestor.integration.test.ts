// A tag's exported path keeps the levels above it even when an ancestor was
// trashed (merged away): the walk used to stop there, so the path lost its
// upper segments and re-imported as a root tag.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { createTag, fullTagPath } from "../services/tagHierarchy.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

describe.skipIf(!isTestDatabase())("fullTagPath", () => {
  let ws = "";
  let admin: ActorCtx = { id: "", name: "Path admin", role: "admin", type: "human" };

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Path', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    admin = await persistActor(ws, admin);
  });

  it("walks past a trashed ancestor, but a trashed tag itself has no path", async () => {
    const top = await createTag({ actor: admin, workspaceId: ws, name: "top" });
    const mid = await createTag({ actor: admin, workspaceId: ws, name: "mid", parentId: top.id });
    const leaf = await createTag({ actor: admin, workspaceId: ws, name: "leaf", parentId: mid.id });
    expect(await fullTagPath(ws, leaf.id)).toBe("top/mid/leaf");
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [mid.id]);
    expect(await fullTagPath(ws, leaf.id)).toBe("top/mid/leaf");
    expect(await fullTagPath(ws, mid.id)).toBe("");
  });
});
