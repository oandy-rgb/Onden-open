// The decisions of spine/authority.ts assertAuthority, one authority kind at a time,
// asserted on the refusal's `reason` and not only on "it threw": a guard that is
// shadowed by a later one (the workspace-config guard, the token check on
// principal_admin) still throws, just with a different reason, and only the reason
// tells which guard did the work. Found by mutation testing
// (docs/archive/research/mutation-2026-10-24.md): these guards could be deleted with every
// existing test still green.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { assertAuthority, AuthorityError, isWorkspaceOwner, reviewAuthority, type Authority } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

/** "ok", or the reason of the AuthorityError it threw; any other error is a test failure. */
async function outcome(actor: ActorCtx, a: Authority): Promise<string> {
  try {
    await assertAuthority(actor, a);
    return "ok";
  } catch (e) {
    if (e instanceof AuthorityError) return e.reason;
    throw e;
  }
}
async function refusal(actor: ActorCtx, a: Authority): Promise<AuthorityError> {
  try { await assertAuthority(actor, a); } catch (e) { if (e instanceof AuthorityError) return e; throw e; }
  throw new Error("expected a refusal");
}

describe.skipIf(!isTestDb)("assertAuthority decisions", () => {
  let ws = "";
  let owner: ActorCtx, editor: ActorCtx, viewer: ActorCtx, outsider: ActorCtx, writeAgent: ActorCtx, readAgent: ActorCtx;
  let sharedSpace = "", privateSpace = "", ownerOnlySpace = "", defaultSpace = "";
  let note = "", privateNote = "", trashedNote = "", tagDef = "", trashedTag = "", configNode = "", configTag = "";

  const human = (role: "admin" | "editor" | "viewer", name: string) =>
    persistActor(ws, { id: "", name: `${name} ${randomUUID().slice(0, 6)}`, role, type: "human" });
  const agent = (access: "read" | "write", name: string) =>
    persistActor(ws, { id: "", name: `${name} ${randomUUID().slice(0, 6)}`, role: "editor", type: "agent",
      tokenScope: { tokenId: "", allowedTools: null, access, writeMode: "apply", expiresAt: null } });
  const insert = async (title: string, type: "content" | "class_tag", opts: { trashed?: boolean } = {}) =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color, deleted_at)
       VALUES ($1,'manual',$2,$3,$4,'body',$5,$6) RETURNING id::text`,
      [ws, type, `${title} ${randomUUID().slice(0, 6)}`, randomUUID(), type === "class_tag" ? "#888" : null, opts.trashed ? new Date() : null])).rows[0]!.id;

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Authority decisions', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    owner = await human("admin", "owner");
    editor = await human("editor", "editor");
    viewer = await human("viewer", "viewer");
    outsider = await human("editor", "outsider");
    writeAgent = await agent("write", "write agent");
    readAgent = await agent("read", "read agent");
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    // The tokens reach only spaces with external AI on.
    await q(`UPDATE spaces SET capabilities = capabilities || '{"external_ai": true}'::jsonb WHERE id = $1`, [defaultSpace]);
    sharedSpace = defaultSpace;
    // A shared space only the editor is in (the owner is not a member; the owner manages it).
    privateSpace = await makeSpace(ws, "editor only", [{ id: editor.id, permission: "edit" }]);
    // A shared space only the owner is in.
    ownerOnlySpace = await makeSpace(ws, "owner only", [{ id: owner.id, permission: "edit" }]);

    note = await insert("note", "content");
    privateNote = await insert("private note", "content");
    await putInSpace(privateNote, ownerOnlySpace);
    trashedNote = await insert("trashed note", "content", { trashed: true });
    tagDef = await insert("tag", "class_tag");
    trashedTag = await insert("trashed tag", "class_tag", { trashed: true });
    configNode = await ensureConfigNode(ws);
    configTag = (await q<{ tag_id: string }>(`SELECT tag_id::text FROM node_tags WHERE node_id = $1`, [configNode])).rows[0]!.tag_id;
  });
  afterAll(async () => {
    if (ws) {
      await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
      await deleteWorkspaceActors(ws);
    }
    await pool.end();
  });

  describe("kinds that need no node", () => {
    it("open and cascade are never refused, whoever asks", async () => {
      for (const who of [owner, viewer, outsider, readAgent]) {
        expect(await outcome(who, { kind: "open", why: "test" })).toBe("ok");
        expect(await outcome(who, { kind: "cascade" })).toBe("ok");
      }
    });

    it("any_space_write: a person or a write agent may; a read-only agent may not", async () => {
      expect(await outcome(editor, { kind: "any_space_write" })).toBe("ok");
      expect(await outcome(viewer, { kind: "any_space_write" })).toBe("ok"); // they manage their personal space
      expect(await outcome(writeAgent, { kind: "any_space_write" })).toBe("ok");
      expect(await outcome(readAgent, { kind: "any_space_write" })).toBe("space");
      expect((await refusal(readAgent, { kind: "any_space_write" })).message).toBe("no space this actor may write");
    });

    it("review: only the owner; an editor and a token get reason 'role'", async () => {
      expect(await outcome(owner, { kind: "review" })).toBe("ok");
      expect(await outcome(editor, { kind: "review" })).toBe("role");
      expect(await outcome(writeAgent, { kind: "review" })).toBe("role");
      expect((await refusal(editor, { kind: "review" })).message).toBe("reviewing agent changes needs the workspace owner");
      expect(await reviewAuthority(owner)).toBe(true);
      expect(await reviewAuthority(editor)).toBe(false);
    });

    it("principal_admin: the owner passes; a person gets 'owner'; a token gets 'principal' even when it could write everywhere", async () => {
      expect(await outcome(owner, { kind: "principal_admin" })).toBe("ok");
      expect(await outcome(editor, { kind: "principal_admin" })).toBe("owner");
      expect((await refusal(editor, { kind: "principal_admin" })).message).toBe("this is reserved to the workspace owner");
      // A token that carries the owner's own actor id is still a token: the token check comes first.
      const ownersToken: ActorCtx = { ...owner, tokenScope: writeAgent.tokenScope };
      for (const who of [writeAgent, readAgent, ownersToken]) expect(await outcome(who, { kind: "principal_admin" })).toBe("principal");
      expect((await refusal(writeAgent, { kind: "principal_admin" })).message).toMatch(/delegated token cannot redefine permissions/);
    });

    it("isWorkspaceOwner is false for a token and for a person who is not the owner", async () => {
      expect(await isWorkspaceOwner(owner)).toBe(true);
      expect(await isWorkspaceOwner(editor)).toBe(false);
      expect(await isWorkspaceOwner(writeAgent)).toBe(false);
      // A token carrying the owner's actor id is not the owner: delegated tokens never are.
      expect(await isWorkspaceOwner({ ...owner, tokenScope: writeAgent.tokenScope })).toBe(false);
    });
  });

  describe("space", () => {
    const personalSpaceOf = async (actor: ActorCtx) =>
      (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [actor.id])).rows[0]!.id;

    it("a member reads, an editor writes, and nobody but the owner manages a shared space", async () => {
      const read: Authority = { kind: "space", spaceId: sharedSpace, need: "read" };
      const write: Authority = { kind: "space", spaceId: sharedSpace, need: "write" };
      const manage: Authority = { kind: "space", spaceId: sharedSpace, need: "manage" };
      expect([await outcome(viewer, read), await outcome(viewer, write), await outcome(viewer, manage)]).toEqual(["ok", "space", "space"]);
      expect([await outcome(editor, read), await outcome(editor, write), await outcome(editor, manage)]).toEqual(["ok", "ok", "space"]);
      expect([await outcome(owner, read), await outcome(owner, write), await outcome(owner, manage)]).toEqual(["ok", "ok", "ok"]);
      expect((await refusal(viewer, write)).message).toBe("space access is below required 'write'");
      expect((await refusal(editor, manage)).message).toBe("space access is below required 'manage'");
    });

    it("managing covers every level: the owner enters a shared space they are not a member of", async () => {
      for (const need of ["read", "write", "manage"] as const) {
        expect(await outcome(owner, { kind: "space", spaceId: privateSpace, need })).toBe("ok");
      }
      // …but a member of nothing is refused at every level
      for (const need of ["read", "write", "manage"] as const) {
        expect(await outcome(outsider, { kind: "space", spaceId: privateSpace, need })).toBe("space");
      }
    });

    it("a person manages their own personal space and the owner does not manage anyone else's", async () => {
      const editorsOwn = await personalSpaceOf(editor);
      expect(await outcome(editor, { kind: "space", spaceId: editorsOwn, need: "manage" })).toBe("ok");
      expect(await outcome(owner, { kind: "space", spaceId: editorsOwn, need: "manage" })).toBe("space");
      expect(await outcome(owner, { kind: "space", spaceId: editorsOwn, need: "read" })).toBe("space");
    });

    it("a space that does not exist is 'not found', and a delegated token cannot act on spaces at all", async () => {
      const missing = await refusal(owner, { kind: "space", spaceId: randomUUID(), need: "read" });
      expect(missing.reason).toBe("space");
      expect(missing.message).toMatch(/^space( .*)? not found$/);
      for (const who of [writeAgent, readAgent]) {
        const e = await refusal(who, { kind: "space", spaceId: sharedSpace, need: "read" });
        expect(e.reason).toBe("space");
        expect(e.message).toBe("a delegated token cannot act on spaces directly; propose the change instead");
      }
    });

    it("space_write: the edit permission there; a token needs write access", async () => {
      expect(await outcome(editor, { kind: "space_write", spaceId: sharedSpace })).toBe("ok");
      expect(await outcome(viewer, { kind: "space_write", spaceId: sharedSpace })).toBe("space");
      expect(await outcome(outsider, { kind: "space_write", spaceId: privateSpace })).toBe("space");
      expect(await outcome(writeAgent, { kind: "space_write", spaceId: sharedSpace })).toBe("ok");
      expect(await outcome(readAgent, { kind: "space_write", spaceId: sharedSpace })).toBe("space");
      expect(await outcome(owner, { kind: "space_write", spaceId: randomUUID() })).toBe("space");
      expect((await refusal(viewer, { kind: "space_write", spaceId: sharedSpace })).message).toBe(`cannot write into space ${sharedSpace}`);
    });
  });

  describe("node and retained_node", () => {
    const WRITE_OPS = ["apply", "remove", "set_attribute", "delete_attribute", "write_node", "delete_node"] as const;

    it("reading needs membership; every other operation needs the edit permission", async () => {
      expect(await outcome(viewer, { kind: "node", nodeId: note, op: "read" })).toBe("ok");
      for (const op of WRITE_OPS) {
        expect(await outcome(viewer, { kind: "node", nodeId: note, op }), `viewer ${op}`).toBe("space");
        expect(await outcome(editor, { kind: "node", nodeId: note, op }), `editor ${op}`).toBe("ok");
      }
      const writeRefused = await refusal(viewer, { kind: "node", nodeId: note, op: "write_node" });
      expect(writeRefused.message).toBe("space role denied 'write_node' on this note");
      expect(writeRefused.message).not.toContain(note);
    });

    it("a note in a space the actor is not in can be neither read nor written", async () => {
      const read = await refusal(editor, { kind: "node", nodeId: privateNote, op: "read" });
      expect(read.reason).toBe("space");
      expect(read.message).toBe("space role denied 'read' on this note");
      expect(read.message).not.toContain(privateNote);
      expect(await outcome(editor, { kind: "node", nodeId: privateNote, op: "write_node" })).toBe("space");
      expect(await outcome(owner, { kind: "node", nodeId: privateNote, op: "write_node" })).toBe("ok");
    });

    it("a node that does not exist is refused like one in a closed space", async () => {
      expect(await outcome(owner, { kind: "node", nodeId: randomUUID(), op: "read" })).toBe("space");
      expect(await outcome(owner, { kind: "retained_node", nodeId: randomUUID(), op: "read" })).toBe("space");
    });

    it("a token reads and writes only where its access and the space allow", async () => {
      expect(await outcome(readAgent, { kind: "node", nodeId: note, op: "read" })).toBe("ok");
      expect(await outcome(readAgent, { kind: "node", nodeId: note, op: "write_node" })).toBe("space");
      expect(await outcome(writeAgent, { kind: "node", nodeId: note, op: "write_node" })).toBe("ok");
      expect(await outcome(writeAgent, { kind: "node", nodeId: privateNote, op: "read" })).toBe("space");
    });

    it("a trashed note is invisible to `node` and open to `retained_node`, for reading and for writing", async () => {
      expect(await outcome(editor, { kind: "node", nodeId: trashedNote, op: "read" })).toBe("space");
      expect(await outcome(editor, { kind: "node", nodeId: trashedNote, op: "write_node" })).toBe("space");
      expect(await outcome(editor, { kind: "retained_node", nodeId: trashedNote, op: "read" })).toBe("ok");
      expect(await outcome(editor, { kind: "retained_node", nodeId: trashedNote, op: "write_node" })).toBe("ok");
      // retained access still follows the space
      expect(await outcome(viewer, { kind: "retained_node", nodeId: trashedNote, op: "write_node" })).toBe("space");
      expect(await outcome(editor, { kind: "retained_node", nodeId: privateNote, op: "read" })).toBe("space");
    });

    it("a tag definition is in no space: anyone reads it, only the owner changes it", async () => {
      expect(await outcome(viewer, { kind: "node", nodeId: tagDef, op: "read" })).toBe("ok");
      expect(await outcome(editor, { kind: "node", nodeId: tagDef, op: "write_node" })).toBe("space");
      expect(await outcome(editor, { kind: "node", nodeId: tagDef, op: "delete_node" })).toBe("space");
      expect(await outcome(owner, { kind: "node", nodeId: tagDef, op: "write_node" })).toBe("ok");
      expect(await outcome(owner, { kind: "node", nodeId: tagDef, op: "delete_node" })).toBe("ok");
      expect(await outcome(writeAgent, { kind: "node", nodeId: tagDef, op: "write_node" })).toBe("space");
    });

    // The Site Config note lives in a system space nobody writes as a note (migration 096),
    // so the space rule alone would also refuse these. The config guard is what makes
    // the refusal about the workspace settings, and it must still hold if that space rule changes.
    it("the workspace-config note: a non-owner is stopped by the config guard, the owner never deletes it", async () => {
      for (const op of ["write_node", "set_attribute", "apply", "delete_node"] as const) {
        const e = await refusal(editor, { kind: "node", nodeId: configNode, op });
        expect(e.reason, `editor ${op}`).toBe("reserved");
      }
      expect((await refusal(editor, { kind: "node", nodeId: configNode, op: "write_node" })).message)
        .toBe(`node ${configNode} holds the workspace settings; changing it requires the workspace owner`);
      const del = await refusal(owner, { kind: "node", nodeId: configNode, op: "delete_node" });
      expect(del.reason).toBe("reserved");
      expect(del.message).toBe(`node ${configNode} holds the workspace settings and cannot be deleted`);
      // The owner is past the config guard for other writes; what stops them is the space rule.
      expect(await outcome(owner, { kind: "node", nodeId: configNode, op: "write_node" })).toBe("space");
      // A token never owns anything
      expect(await outcome(writeAgent, { kind: "node", nodeId: configNode, op: "write_node" })).toBe("reserved");
    });

    it("reading the config note is not a config matter: the guard does not apply to `read`", async () => {
      expect(await outcome(editor, { kind: "node", nodeId: configNode, op: "read" })).not.toBe("reserved");
      expect(await outcome(editor, { kind: "retained_node", nodeId: configNode, op: "read" })).not.toBe("reserved");
    });
  });

  describe("tag_membership", () => {
    it("tagging a note is editing it: the edit permission on the note, then the tag", async () => {
      expect(await outcome(editor, { kind: "tag_membership", nodeId: note, tagId: tagDef, op: "apply" })).toBe("ok");
      expect(await outcome(editor, { kind: "tag_membership", nodeId: note, tagId: tagDef, op: "remove" })).toBe("ok");
      const viewerRefused = await refusal(viewer, { kind: "tag_membership", nodeId: note, tagId: tagDef, op: "apply" });
      expect(viewerRefused.reason).toBe("space");
      expect(viewerRefused.message).toBe("space role denied tagging this note");
      expect(viewerRefused.message).not.toContain(note);
      expect(await outcome(editor, { kind: "tag_membership", nodeId: privateNote, tagId: tagDef, op: "apply" })).toBe("space");
      expect(await outcome(readAgent, { kind: "tag_membership", nodeId: note, tagId: tagDef, op: "apply" })).toBe("space");
      expect(await outcome(writeAgent, { kind: "tag_membership", nodeId: note, tagId: tagDef, op: "apply" })).toBe("ok");
    });

    it("a trashed note cannot be tagged", async () => {
      const e = await refusal(editor, { kind: "tag_membership", nodeId: trashedNote, tagId: tagDef, op: "apply" });
      expect(e.reason).toBe("space");
      expect(e.message).toBe("space role denied tagging this note");
      expect(e.message).not.toContain(trashedNote);
      expect(await outcome(owner, { kind: "tag_membership", nodeId: trashedNote, tagId: tagDef, op: "remove" })).toBe("space");
    });

    it("the tag must be a live definition the actor can see", async () => {
      const e = await refusal(editor, { kind: "tag_membership", nodeId: note, tagId: trashedTag, op: "apply" });
      expect(e.reason).toBe("space");
      expect(e.message).toBe(`tag ${trashedTag} is not readable`);
      expect(await outcome(editor, { kind: "tag_membership", nodeId: note, tagId: randomUUID(), op: "remove" })).toBe("space");
    });

    it("the config note cannot be tagged or untagged by a non-owner, and the config tag cannot be applied by one", async () => {
      const configRefused = await refusal(editor, { kind: "tag_membership", nodeId: configNode, tagId: tagDef, op: "apply" });
      expect(configRefused.reason).toBe("reserved");
      expect(configRefused.message).toBe(`node ${configNode} holds the workspace settings; changing it requires the workspace owner`);
      expect(await outcome(editor, { kind: "tag_membership", nodeId: configNode, tagId: tagDef, op: "remove" })).toBe("reserved");
      expect(await outcome(editor, { kind: "tag_membership", nodeId: note, tagId: configTag, op: "apply" })).toBe("reserved");
      // the owner passes the config guards; the config note's own space still refuses tagging it
      expect(await outcome(owner, { kind: "tag_membership", nodeId: note, tagId: configTag, op: "apply" })).toBe("ok");
      expect(await outcome(owner, { kind: "tag_membership", nodeId: configNode, tagId: tagDef, op: "apply" })).toBe("space");
    });
  });

  describe("tag", () => {
    it("reading, applying and removing need only a live definition; changing it is the owner's", async () => {
      for (const op of ["read", "apply", "remove"] as const) {
        expect(await outcome(viewer, { kind: "tag", tagId: tagDef, op }), `viewer ${op}`).toBe("ok");
        expect(await outcome(readAgent, { kind: "tag", tagId: tagDef, op }), `read agent ${op}`).toBe("ok");
      }
      for (const op of ["set_attribute", "delete_attribute", "write_node", "delete_node"] as const) {
        const e = await refusal(editor, { kind: "tag", tagId: tagDef, op });
        expect(e.reason, `editor ${op}`).toBe("owner");
        expect(e.message).toBe(`changing tag ${tagDef} is reserved to the workspace owner`);
        expect(await outcome(owner, { kind: "tag", tagId: tagDef, op }), `owner ${op}`).toBe("ok");
        expect(await outcome(writeAgent, { kind: "tag", tagId: tagDef, op }), `agent ${op}`).toBe("owner");
      }
    });

    it("a trashed or missing definition cannot be read, applied or removed", async () => {
      for (const op of ["read", "apply", "remove"] as const) {
        expect(await outcome(editor, { kind: "tag", tagId: trashedTag, op })).toBe("space");
        expect(await outcome(owner, { kind: "tag", tagId: randomUUID(), op })).toBe("space");
      }
      expect((await refusal(editor, { kind: "tag", tagId: trashedTag, op: "read" })).message).toBe(`tag ${trashedTag} is not readable`);
    });

    it("the workspace-config tag: reading is open; any change, even applying it, needs the owner; nobody deletes it", async () => {
      expect(await outcome(editor, { kind: "tag", tagId: configTag, op: "read" })).toBe("ok");
      for (const op of ["apply", "remove", "set_attribute", "write_node", "delete_node"] as const) {
        expect(await outcome(editor, { kind: "tag", tagId: configTag, op }), `editor ${op}`).toBe("reserved");
      }
      expect(await outcome(owner, { kind: "tag", tagId: configTag, op: "apply" })).toBe("ok");
      expect(await outcome(owner, { kind: "tag", tagId: configTag, op: "write_node" })).toBe("ok");
      const del = await refusal(owner, { kind: "tag", tagId: configTag, op: "delete_node" });
      expect(del.reason).toBe("reserved");
      expect(del.message).toBe(`tag ${configTag} holds the workspace settings and cannot be deleted`);
    });
  });
});
