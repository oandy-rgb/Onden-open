// 「被引用 N 次」: who cites the paragraphs of a note (services/blockCitations.ts,
// route GET /nodes/:id/block-citations). The count is made from the notes whose
// wikilink edges point here, cut by the caller's read scope inside the query:
// a note the reader cannot read is neither listed nor counted.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { listBlockCitations } from "../services/blockCitations.js";
import { ensureBlockAnchor } from "../services/blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, joinDefaultSpace, putInSpace } from "./helpers/spaceFixtures.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let owner: ActorCtx = { id: "cite-admin", name: "Cite admin", role: "admin", type: "human" };
let outsider: ActorCtx = { id: "cite-viewer", name: "Cite outsider", role: "editor", type: "human" };
let reader: ActorCtx = owner;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", reader); await next(); });
app.route("/nodes", nodesRouter);

let defaultSpace = "";
let privateSpace = "";
const tag = () => randomUUID().slice(0, 6);
const note = async (title: string, markdown: string, spaceId?: string) => {
  // Created in its space: a link is matched within the citing note's space when it is saved.
  return String((await createNote({ actor: owner, workspaceId, title, markdown, spaceId: spaceId ?? defaultSpace, event: { uiContext: "test" } })).node.id);
};
/** The anchor of the block of `noteId` that contains `needle`: a paragraph is cited by its anchor's id (the text has no `^id`). */
const anchorOf = async (noteId: string, needle: string) => {
  const markdown = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [noteId])).rows[0]!.markdown;
  return (await ensureBlockAnchor(workspaceId, noteId, markdown, markdown.indexOf(needle), { actor: owner }))!;
};
const citations = async (id: string, as: ActorCtx = owner) => (await listBlockCitations(as, workspaceId, id))
  .map((r) => `${r.block_ref}:${r.source_title}:${r.uses}`).sort();

describe.skipIf(!isTestDb)("block citations (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Cite',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, owner);
    outsider = await persistActor(workspaceId, outsider);
    await joinDefaultSpace(workspaceId, owner.id, "admin");
    await joinDefaultSpace(workspaceId, outsider.id);
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
    privateSpace = await adminOnlySpace(workspaceId, `private-${tag()}`, [owner.id]);
  });

  it("counts links and embeds by paragraph, a note citing twice counts twice", async () => {
    const t = tag();
    const target = await note(`Target-${t}`, "第一段\n\n第二段\n");
    const p1 = await anchorOf(target, "第一段"), p2 = await anchorOf(target, "第二段");
    const one = `One-${t}`, two = `Two-${t}`;
    await note(one, `看 [[Target-${t}#^${p1}]]\n`);
    await note(two, `![[Target-${t}#^${p1}]]\n\n再看 [[Target-${t}#^${p1}]] 和 [[Target-${t}#^${p2}]]\n`);
    expect(await citations(target)).toEqual([`${p1}:${one}:1`, `${p1}:${two}:2`, `${p2}:${two}:1`].sort());
  });

  it("a link to the whole note, a heading, or another note is not a citation", async () => {
    const t = tag();
    const target = await note(`Target-${t}`, "段\n");
    const p1 = await anchorOf(target, "段");
    await note(`Plain-${t}`, `[[Target-${t}]] [[Target-${t}#標題]] [[Other-${t}#^${p1}]]\n`);
    expect(await citations(target)).toEqual([]);
  });

  it("follows edits and removal of the citing text", async () => {
    const t = tag();
    const target = await note(`Target-${t}`, "段\n");
    const p1 = await anchorOf(target, "段");
    const source = await note(`Src-${t}`, `[[Target-${t}#^${p1}]]\n`);
    expect(await citations(target)).toEqual([`${p1}:Src-${t}:1`]);
    await updateNode(workspaceId, source, { markdown: "不再引用\n" }, { actor: owner });
    expect(await citations(target)).toEqual([]);
  });

  it("a citing note the reader cannot read is not listed or counted", async () => {
    // A title link resolves only within its own space, and a move drops the edges that then cross
    // spaces (relinkAfterMove), so this edge is one left behind: the raw move below skips the relink.
    // The read scope in the query still cuts it.
    const t = tag();
    const target = await note(`Target-${t}`, "段\n");
    const p1 = await anchorOf(target, "段");
    await note(`Open-${t}`, `[[Target-${t}#^${p1}]]\n`);
    await putInSpace(await note(`Secret-${t}`, `[[Target-${t}#^${p1}]] [[Target-${t}#^${p1}]]\n`), privateSpace);
    expect(await citations(target, owner)).toEqual([`${p1}:Open-${t}:1`, `${p1}:Secret-${t}:2`].sort());
    expect(await citations(target, outsider)).toEqual([`${p1}:Open-${t}:1`]);
  });

  it("an unreadable or missing note answers like one nobody cites", async () => {
    const t = tag();
    const hidden = await note(`Hidden-${t}`, "段\n", privateSpace);
    const p1 = await anchorOf(hidden, "段");
    await note(`Src-${t}`, `[[Hidden-${t}#^${p1}]]\n`, privateSpace);
    expect(await citations(hidden, outsider)).toEqual([]);
    expect(await citations(randomUUID())).toEqual([]);
  });

  it("the route answers { citations } and an empty list for a malformed id", async () => {
    const t = tag();
    const target = await note(`Target-${t}`, "段\n");
    const p1 = await anchorOf(target, "段");
    await note(`Src-${t}`, `[[Target-${t}#^${p1}]]\n`);
    reader = owner;
    const res = await app.request(`/nodes/${target}/block-citations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ citations: [{ block_ref: p1, source_id: expect.any(String), source_title: `Src-${t}`, uses: 1 }] });
    expect(await (await app.request(`/nodes/not-a-uuid/block-citations`)).json()).toEqual({ citations: [] });
  });
});
