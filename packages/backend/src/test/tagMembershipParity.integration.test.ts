// The backend's tag membership (/api/query `tags`, tagHierarchy.memberTagIds:
// the tag, its child tags and the tags extending it, every tag with the name)
// over the same fixture the frontend's Bases file.hasTag is checked against
// (packages/frontend/src/test/basesTagParity.test.ts): both must list the
// same notes. System machinery (a source_type='system' note, the
// workspace-config tag even when it carries a tag) lists on neither end.
// `members` holds memberTagIds by tag id to the frontend's tag page/sidebar.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import queryRouter from "../routes/query.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { memberTagIds } from "../services/tagHierarchy.js";
import { LISTED_NODE_SQL } from "../spine/reservedNodes.js";
import { executeView } from "../services/collectionViewQuery.js";
import { searchNodes } from "../services/nodeSearch.js";
import { gatherTag } from "../services/harness/scope.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

// View layouts come from the view modules, which the real app registers on start.
registerShippedModules();

type Fixture = {
  tags: Array<{ key: string; name: string; parent?: string; extends?: string[]; viewModule?: string; reserved?: string; tags?: string[] }>;
  notes: Array<{ key: string; tags: string[]; system?: boolean }>;
  expect: Record<string, string[]>;
  members: Record<string, string[]>;
};
const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, "../../../frontend/src/test/fixtures/tagMembershipParity.json"), "utf8")) as Fixture;

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "parity-admin", name: "Parity", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/query", queryRouter);

describe.skipIf(!isTestDb)("tag membership matches the frontend's Bases file.hasTag (DB)", () => {
  const ids = new Map<string, string>();
  const keyOf = new Map<string, string>();
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Parity',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    for (const t of fixture.tags) ids.set(t.key, randomUUID()); // ids first: extends may point forward
    for (const t of fixture.tags) {
      await seedQ(
        `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, tag_schema, reserved_key)
         VALUES ($1, $2, 'manual', 'class_tag', $3, $4, '', $5, $6::jsonb, $7)`,
        [ids.get(t.key), workspaceId, t.name, `tag-${randomUUID()}`, t.parent ? ids.get(t.parent) : null,
          t.extends || t.viewModule ? JSON.stringify({
            fields: [], views: {}, ...(t.extends ? { extends: t.extends.map((k) => ids.get(k)) } : {}),
            ...(t.viewModule ? { module: t.viewModule } : {}),
          }) : null,
          t.reserved ?? null],
      );
    }
    for (const t of fixture.tags) {
      keyOf.set(ids.get(t.key)!, t.key);
      for (const tag of t.tags ?? []) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [ids.get(t.key), ids.get(tag)]);
    }
    for (const n of fixture.notes) {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, $4, 'content', $2, $3, '') RETURNING id::text`,
        [workspaceId, n.key, randomUUID(), n.system ? "system" : "manual"])).rows[0]!.id;
      keyOf.set(id, n.key);
      for (const t of n.tags) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, ids.get(t)]);
    }
  });

  for (const [name, expected] of Object.entries(fixture.expect)) {
    it(`tags: ["${name}"]`, async () => {
      const res = await app.request("/query", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: [name], limit: 200 }),
      });
      expect(res.status).toBe(200);
      const { rows } = (await res.json()) as { rows: Array<{ id: string }> };
      expect(rows.map((r) => keyOf.get(r.id)).sort()).toEqual([...expected].sort());
    });
  }

  // D54: search `#name` and the AI tag scope (Ask AI / Slides › Make deck from
  // tag) count a tag's notes by the same rule — before, search counted only
  // notes carrying the named tag itself and gatherTag left child tags out.
  // Both hide system machinery as /api/query does (D54 follow-up): sys1 and
  // wsConfig carry Course and 課程 and must list on neither.
  for (const [name, expected] of Object.entries(fixture.expect)) {
    it(`search #${name} lists the same notes`, async () => {
      const rows = await searchNodes(workspaceId, `#${name}`, actor, 200);
      expect(rows.map((r) => keyOf.get(r.id)).sort()).toEqual([...expected].sort());
    });
  }
  for (const [key, expected] of Object.entries(fixture.members)) {
    it(`AI tag scope of #${key} gathers its members`, async () => {
      // A tag without readable members has no scope to send (ScopeUnavailable).
      if (!expected.length) {
        await expect(gatherTag(workspaceId, actor, { tagId: ids.get(key)! })).rejects.toThrow();
        return;
      }
      const gathered = await gatherTag(workspaceId, actor, { tagId: ids.get(key)! });
      expect(gathered.sources.map((s) => (s.id ? keyOf.get(s.id) : undefined)).sort())
        .toEqual([...expected].sort());
    });
  }

  // `members` is keyed by tag, not name (T4): the notes of ONE tag — the
  // frontend's tag page, sidebar and tagMembers list exactly these
  // (packages/frontend/src/test/tagMembersParity.test.tsx).
  for (const [key, expected] of Object.entries(fixture.members)) {
    it(`memberTagIds(#${key}) lists the frontend's members`, async () => {
      const tagIds = await memberTagIds(workspaceId, ids.get(key)!);
      const rows = await q<{ id: string }>(
        `SELECT DISTINCT n.id::text FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id
          WHERE nt.tag_id = ANY($1::uuid[]) AND n.deleted_at IS NULL AND n.hidden = false
            AND ${LISTED_NODE_SQL("n")}`, [tagIds]);
      expect(rows.rows.map((r) => keyOf.get(r.id)).sort()).toEqual([...expected].sort());
    });
  }

  // An ordinary tag DEFINITION carrying a tag is not a result row of /api/query
  // or a saved view — as before T5, when the keyless-tag NULL hid it by
  // accident; LISTED_NODE_SQL now states it.
  it("tag definitions never list in /api/query or a saved view, even carrying a member tag", async () => {
    const defId = randomUUID();
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'manual', 'class_tag', 'Tagged definition', $3, '')`, [defId, workspaceId, `tag-${randomUUID()}`]);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [defId, ids.get("course")]);
    try {
      for (const body of [{ tags: ["Course"], limit: 200 }, { limit: 200 }]) {
        const res = await app.request("/query", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const listed = ((await res.json()) as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
        expect(listed).not.toContain(defId);
        expect(listed).not.toContain(ids.get("course"));
      }
      const view = await executeView({
        workspaceId, tagId: ids.get("course")!, filters: [], sorts: [], visibleFields: [], limit: 200,
        readableIds: [defId, ...keyOf.keys()],
      });
      expect(view.rows.map((r) => r.id)).not.toContain(defId);
      expect(view.rows.map((r) => keyOf.get(r.id)).sort()).toEqual([...fixture.members.course].sort());
    } finally {
      await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [defId]);
    }
  });

  it("an unfiltered query lists no system machinery", async () => {
    const res = await app.request("/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 200 }),
    });
    expect(res.status).toBe(200);
    const listed = ((await res.json()) as { rows: Array<{ id: string }> }).rows.map((r) => keyOf.get(r.id));
    expect(listed).toContain("n6");
    expect(listed).not.toContain("sys1");
    expect(listed).not.toContain("wsConfig");
  });

  it("an unknown key is refused, not ignored (`tag` used to list every note)", async () => {
    const res = await app.request("/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "課程" }),
    });
    expect(res.status).toBe(400);
  });
});
