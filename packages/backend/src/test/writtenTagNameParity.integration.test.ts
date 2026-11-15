// A tag name written in a note names one tag (D63). tagIdForWrittenName is the
// rule — from the root, exact title first, else the one case-insensitive
// match — and every writer of a written name goes through it:
//   * over the fixture the frontend's offline lookup (lib/data/tagPaths.ts
//     findTagIdByPath, src/test/writtenTagNameParity.test.ts) is checked
//     against, the server answers the same;
//   * frontmatter `tags:` (import → resolveOrCreateTagPath, also quick
//     capture's resolve-path) and a block's `{tag}` land on the same tag — the
//     two divergences D63 found: only `課程/book` exists (both now make one
//     root `book`), and a root `Book` exists (both attach it);
//   * with block nodes off (the default), frontmatter tags resolve the same.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { q } from "../db.js";
import { tagIdForWrittenName, resolveOrCreateTagPath } from "../services/tagHierarchy.js";
import { importMarkdownNote } from "../modules/importers/markdown/note.js";
import { createNote } from "../services/noteCreate.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

type Fixture = {
  cases: Array<{ title: string; tags: Array<{ key: string; name: string; parent?: string }>; resolve: Record<string, string | null> }>;
};
const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, "../../../frontend/src/test/fixtures/writtenTagNameParity.json"), "utf8")) as Fixture;

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
registerShippedModules();

const newWorkspace = async (name: string) =>
  (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id::text`, [name, randomUUID()])).rows[0]!.id;
const insertTag = async (workspaceId: string, title: string, parentId: string | null = null) =>
  (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
     VALUES ($1, 'manual', 'class_tag', $2, $3, '', $4) RETURNING id::text`,
    [workspaceId, title, `tag-${randomUUID()}`, parentId],
  )).rows[0]!.id;

describe.skipIf(!isTestDb)("a written tag name: the server's rule over the client's fixture (DB)", () => {
  for (const c of fixture.cases) {
    it(c.title, async () => {
      const workspaceId = await newWorkspace(`Written ${c.title}`);
      const ids = new Map<string, string>();
      for (const t of c.tags) ids.set(t.key, await insertTag(workspaceId, t.name, t.parent ? ids.get(t.parent)! : null));
      for (const [written, expected] of Object.entries(c.resolve)) {
        const { id, created } = await tagIdForWrittenName(workspaceId, written, { create: false });
        expect({ written, id }).toEqual({ written, id: expected === null ? null : ids.get(expected) });
        expect(created).toEqual([]);
      }
    });
  }
});

describe.skipIf(!isTestDb)("frontmatter tags and block {tags} name one tag (DB)", () => {
  let workspaceId = "";
  let actor: ActorCtx = { id: "written-admin", name: "Written", role: "admin", type: "human" };
  beforeAll(async () => {
    workspaceId = await newWorkspace("Written tags");
    actor = await persistActor(workspaceId, actor);
  });

  /** A note whose block says `{name}` (saved first: the order in which the
   *  two rules used to part), then an imported note whose frontmatter says
   *  `tags: [name]`; the block's tags and the imported note's tags. */
  const writeBoth = async (name: string) => {
    const { node } = await createNote({ actor, workspaceId, title: `Block ${randomUUID().slice(0, 6)}`, markdown: `- 讀 {${name}}`, event: { uiContext: "test.d63" } });
    const blockTags = (await q<{ tag_id: string }>(
      `SELECT bt.tag_id::text FROM block_node_tags bt JOIN block_nodes b ON b.id = bt.block_node_id
        WHERE b.note_id = $1`, [node.id as string])).rows.map((r) => r.tag_id);
    const title = `Front ${randomUUID().slice(0, 6)}`;
    const result = await importMarkdownNote({
      actor, workspaceId, source: { id: randomUUID(), name: "d63" }, parentId: null, reuse: false,
      file: { path: `${title}.md`, content: `---\ntitle: ${title}\ntags: [${name}]\n---\nbody\n` },
    });
    expect(result).toMatchObject({ status: "imported" });
    const noteTags = (await q<{ tag_id: string }>(
      `SELECT nt.tag_id::text FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id
        WHERE n.workspace_id = $1 AND n.title = $2`, [workspaceId, title])).rows.map((r) => r.tag_id);
    return { noteTags, blockTags };
  };
  const rootTags = async (name: string) => (await q<{ id: string }>(
    `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL
        AND parent_id IS NULL AND lower(title) = lower($2)`, [workspaceId, name])).rows.map((r) => r.id);

  it("only 課程/book exists: `tags: [book]` and `{book}` both make one root book", async () => {
    const name = `book${randomUUID().slice(0, 4)}`;
    const nested = await insertTag(workspaceId, name, await insertTag(workspaceId, `課程${randomUUID().slice(0, 4)}`));
    const { noteTags, blockTags } = await writeBoth(name);
    const [root] = await rootTags(name);
    expect(root).toBeDefined();
    expect(root).not.toBe(nested);
    expect(noteTags).toEqual([root]);
    expect(blockTags).toEqual([root]);
    // Quick capture's resolve-path answers the same tag.
    expect((await resolveOrCreateTagPath(workspaceId, name, actor)).leafId).toBe(root);
  });

  it("a root Book exists: `tags: [book]` and `{book}` both attach it, no second root", async () => {
    const suffix = randomUUID().slice(0, 4);
    const book = await insertTag(workspaceId, `Book${suffix}`);
    const { noteTags, blockTags } = await writeBoth(`book${suffix}`);
    expect(noteTags).toEqual([book]);
    expect(blockTags).toEqual([book]);
    expect(await rootTags(`book${suffix}`)).toEqual([book]);
    expect(await resolveOrCreateTagPath(workspaceId, `BOOK${suffix}`, actor)).toEqual({ leafId: book, created: [] });
  });
});
