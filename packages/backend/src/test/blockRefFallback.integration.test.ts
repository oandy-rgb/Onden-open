// `[[A#^id]]` when A no longer holds the block: which other note the reader
// may read holds it (services/blockRefLookup.ts, @onden/markdown
// chooseBlockHome). The id is an anchor id; real write paths keep the
// note_block_refs index from the notes' valid anchors, and the lookup trusts only
// that index (it never reads a body). It is cut by the caller's read scope, so a
// private note's block is neither found nor counted. An anchor id belongs to one
// note, so a second holder (a pasted template, a rival) is made by adding index
// rows with seedQ — the one thing real saves cannot produce any more.
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
import { trashNode } from "../services/nodeTrash.js";
import { findBlockHome } from "../services/blockRefLookup.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { adminOnlySpace, joinDefaultSpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let owner: ActorCtx = { id: "ref-admin", name: "Ref admin", role: "admin", type: "human" };
let outsider: ActorCtx = { id: "ref-viewer", name: "Ref outsider", role: "editor", type: "human" };
let reader: ActorCtx = owner;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", reader); await next(); });
app.route("/nodes", nodesRouter);

const note = async (title: string, markdown: string, opts: { parentId?: string; spaceId?: string } = {}) => {
  const id = String((await createNote({ actor: owner, workspaceId, title, markdown, parentId: opts.parentId, event: { uiContext: "test" } })).node.id);
  // createNote files a note in its author's personal space; the shared default
  // space is what the other readers share. A child already follows its parent.
  if (!opts.parentId) await putInSpace(id, opts.spaceId ?? defaultSpace);
  return id;
};
const refs = async (id: string) => (await q<{ block_ref: string }>(
  `SELECT block_ref FROM note_block_refs WHERE note_id = $1 ORDER BY block_ref`, [id])).rows.map((r) => r.block_ref);
/** The one anchor id a note holds (a `{…}` block gets its anchor at save). */
const refOf = async (id: string) => { const r = await refs(id); expect(r).toHaveLength(1); return r[0]!; };
/** Index rows that say `noteId` also holds `ref` (a state real saves cannot make: anchor ids are unique). */
const alsoHolds = async (noteId: string, ref: string) => {
  await seedQ(`INSERT INTO note_block_refs (workspace_id, note_id, block_ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [workspaceId, noteId, ref]);
};
const home = async (from: string, ref: string, as: ActorCtx = owner) => (await findBlockHome(as, workspaceId, from, ref))?.id ?? null;
let defaultSpace = "";
const tag = () => randomUUID().slice(0, 6);

describe.skipIf(!isTestDb)("[[A#^id]] fallback (DB)", () => {
  let privateSpace = "";
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Block ref',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, owner);
    outsider = await persistActor(workspaceId, outsider);
    await joinDefaultSpace(workspaceId, owner.id, "admin");
    await joinDefaultSpace(workspaceId, outsider.id);
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
    privateSpace = await adminOnlySpace(workspaceId, `private-${tag()}`, [owner.id]);
  });

  it("the index follows every write: create, edit, trash — and a typed ^id is only text", async () => {
    const id = await note(`索引-${tag()}`, "一段 {x}\n\n```\nnot ^in-code\n```\n\n- 項目 {y}\n\n文字 ^typed\n");
    const first = await refs(id);
    expect(first).toHaveLength(2);
    expect(first.every((r) => /^[0-9a-f]{6}$/.test(r))).toBe(true);
    expect(first).not.toContain("typed"); // `^typed` is plain text: no anchor, no index row
    await updateNode(workspaceId, id, { markdown: "- 項目 {y}\n\n新的 {z}\n" }, { actor: owner });
    const second = await refs(id);
    expect(second).toHaveLength(2);
    expect(second.filter((r) => first.includes(r))).toHaveLength(1); // the block that stayed keeps its anchor
    await updateNode(workspaceId, id, { markdown: "沒有任何 id\n" }, { actor: owner });
    expect(await refs(id)).toEqual([]);
  });

  it("finds the one note that holds the id; none, or the named note's own id, is not a fallback", async () => {
    const a = await note(`A-${tag()}`, "原文已搬走\n");
    const b = await note(`B-${tag()}`, "搬到這裡的段落 {m}\n");
    const m1 = await refOf(b);
    expect(await home(a, m1)).toBe(b);
    expect(await home(a, "ffffff")).toBeNull();
    expect(await home(b, m1)).toBeNull(); // the named note itself is never its own fallback
  });

  it("the route answers { home } for the caller, and nothing for a malformed id", async () => {
    const a = await note(`A-${tag()}`, "x\n");
    const b = await note(`B-${tag()}`, "y {r}\n");
    const r1 = await refOf(b);
    reader = owner;
    const res = await app.request(`/nodes/${a}/block-home/${r1}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ home: { id: b, title: expect.any(String), slug: expect.any(String) } });
    expect(await (await app.request(`/nodes/${a}/block-home/${encodeURIComponent("no way")}`)).json()).toEqual({ home: null });
    expect(await (await app.request(`/nodes/not-a-uuid/block-home/${r1}`)).json()).toEqual({ home: null });
  });

  it("several holders: the ones under the named note win, then the same space, else it gives up", async () => {
    const a = await note(`A-${tag()}`, "gone\n");
    const stray1 = await note(`S1-${tag()}`, "paste {d}\n");
    const dup = await refOf(stray1);
    const stray2 = await note(`S2-${tag()}`, "paste {d}\n");
    await alsoHolds(stray2, dup);
    expect(await home(a, dup)).toBeNull(); // two equal candidates: not a guess

    const child = await note(`C-${tag()}`, "moved {d}\n", { parentId: a });
    await alsoHolds(child, dup);
    expect(await home(a, dup)).toBe(child); // under A wins

    const grandchild = await note(`G-${tag()}`, "moved again {d}\n", { parentId: child });
    const dup2 = await refOf(grandchild);
    const s3 = await note(`S3-${tag()}`, "paste {d}\n");
    await alsoHolds(s3, dup2);
    expect(await home(a, dup2)).toBe(grandchild); // any depth

    const other = await note(`O-${tag()}`, "x\n", { spaceId: privateSpace });
    const inOtherSpace = await note(`P-${tag()}`, "z {s}\n", { spaceId: privateSpace });
    const sp = await refOf(inOtherSpace);
    const inDefault = await note(`D-${tag()}`, "z {s}\n");
    await alsoHolds(inDefault, sp);
    expect(await home(other, sp)).toBe(inOtherSpace); // same space as the named note
    expect(await home(a, sp)).toBe(inDefault);
  });

  it("a trashed note is not a home", async () => {
    const a = await note(`A-${tag()}`, "gone\n");
    const b = await note(`B-${tag()}`, "here {t}\n");
    const t1 = await refOf(b);
    expect(await home(a, t1)).toBe(b);
    await trashNode(owner, workspaceId, b);
    expect(await home(a, t1)).toBeNull();
  });

  it("never reveals a note the reader cannot read: not as the answer, not as a rival", async () => {
    const a = await note(`A-${tag()}`, "gone\n");
    const secret = await note(`Secret-${tag()}`, "private words {p}\n", { spaceId: privateSpace });
    const p1 = await refOf(secret);
    const visible = await note(`Visible-${tag()}`, "public words {p}\n");
    const p2 = await refOf(visible);
    expect(await home(a, p1, owner)).toBe(secret);   // the owner may read it
    expect(await home(a, p1, outsider)).toBeNull();  // the outsider gets the same answer as for an id nobody holds
    expect(await home(a, p1, outsider)).toBe(await home(a, "ffffff", outsider));
    expect(await home(a, p2, outsider)).toBe(visible);

    // A rival the reader cannot read is not counted: the owner sees two equal
    // candidates (ambiguous), the outsider only the one it may read.
    const shared = await makeSpace(workspaceId, `shared-${tag()}`, [{ id: owner.id }, { id: outsider.id }]);
    const mine = await note(`Mine-${tag()}`, "private {q}\n", { spaceId: privateSpace });
    const p3 = await refOf(mine);
    const ours = await note(`Ours-${tag()}`, "shared {q}\n", { spaceId: shared });
    await alsoHolds(ours, p3);
    expect(await home(a, p3, owner)).toBeNull();
    expect(await home(a, p3, outsider)).toBe(ours);

    // The named note itself unreadable: nothing, not even that it exists.
    const hidden = await note(`Hidden-${tag()}`, "x\n", { spaceId: privateSpace });
    expect(await home(hidden, p2, outsider)).toBeNull();
    reader = outsider;
    expect(await (await app.request(`/nodes/${hidden}/block-home/${p2}`)).json()).toEqual({ home: null });
    reader = owner;
  });

  it("a token scoped to another space does not see it either", async () => {
    const agent = await persistActor(workspaceId, { id: "", name: `bot-${tag()}`, role: "editor", type: "agent" });
    await q(`DELETE FROM space_members WHERE actor_id = $1`, [agent.id]);
    const space = await makeSpace(workspaceId, `agent-${tag()}`, [{ id: agent.id, permission: "edit" }]);
    const token: ActorCtx = { ...agent, tokenScope: { tokenId: "ref-tok", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null } };
    const a = await note(`A-${tag()}`, "gone\n", { spaceId: space });
    const inDefault = await note(`D-${tag()}`, "x {k}\n");
    const inSpace = await note(`E-${tag()}`, "x {k}\n", { spaceId: space });
    expect(await home(a, await refOf(inDefault), token)).toBeNull();
    expect(await home(a, await refOf(inSpace), token)).toBe(inSpace);
  });

  it("only reads a handful of candidates: a pasted-everywhere id is not found, not scanned", async () => {
    const a = await note(`A-${tag()}`, "gone\n");
    const first = await note(`T-${tag()}-0`, "template {tpl}\n");
    const tpl = await refOf(first);
    for (let i = 1; i < 21; i++) await alsoHolds(await note(`T-${tag()}-${i}`, "template\n"), tpl);
    expect(await home(a, tpl)).toBeNull();
  });
});
