// A note made under a 「不發布」 note starts 「不發布」 too (owner 2026-11-13): services/siteDefault.ts, decided in
// createNote, which every way of making a note goes through (REST, the agent's createNode, import, a block made a
// child note) plus the two inserts that do not (a copy, a template slot). Only the direct parent counts, existing
// notes are never re-judged, and a person's own 「放回網站」 / 「不發布」 replaces the default.
// Each case checks the control (a note under a published parent IS on the site) so it could fail.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { importMarkdownNote } from "../modules/importers/markdown/note.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { moveBlockToChildNote } from "../services/blockChildNote.js";
import { ensureBlockAnchor } from "../services/blockAnchors/index.js";
import { createNote } from "../services/noteCreate.js";
import { createNode } from "../services/agentTools/createNode.js";
import { publishedNodeIds, leftOutNotes } from "../modules/website/publishing/publishedSet.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/nodes", nodesRouter);
  return hono;
}
const send = (a: ActorCtx, url: string, method: string, body: unknown = {}) =>
  app(a).request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!isTestDatabase())("a note made under a 「不發布」 note starts 「不發布」", () => {
  let ws = "";
  let solo: ActorCtx;
  let site = "";
  const stamp = randomUUID().slice(0, 6);

  const create = async (title: string, extra: Record<string, unknown> = {}) => {
    const res = await send(solo, "/api/nodes", "POST", { title, markdown: `${title} 的內文。\n`, space_id: site, ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const keepOff = async (id: string) => expect((await send(solo, `/api/nodes/${id}/attributes/_published`, "PUT", { value: "false", value_type: "bool" })).status).toBe(200);
  const putBack = async (id: string) => expect((await send(solo, `/api/nodes/${id}/attributes/_published`, "DELETE")).status).toBe(200);
  const attr = async (id: string, key: string) => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0]?.value ?? null;
  const flagOf = (id: string) => attr(id, "_published");
  const markOf = (id: string) => attr(id, "_published_by_parent");
  const onSite = async (id: string) => (await publishedNodeIds(ws)).has(id);
  /** A kept-off parent and a published one, each with some text so neither is blank. */
  const parents = async (markdown?: string) => {
    const extra = markdown === undefined ? {} : { markdown };
    const off = await create(`Off ${randomUUID().slice(0, 4)}`, extra);
    await keepOff(off);
    return { off, plain: await create(`Plain ${randomUUID().slice(0, 4)}`, extra) };
  };
  const expectInherited = async (id: string) => {
    expect(await flagOf(id)).toBe("false");
    expect(await markOf(id)).toBe("true");
    expect(await onSite(id)).toBe(false);
  };
  const expectUntouched = async (id: string) => {
    expect(await flagOf(id)).toBeNull();
    expect(await markOf(id)).toBeNull();
    expect(await onSite(id)).toBe(true);
  };

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Parent default', $1) RETURNING id::text`, [`parent-default-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    solo = await persistActor(ws, { id: "", name: `Solo ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    await q(`UPDATE spaces SET capabilities = capabilities || '{"publish": true}'::jsonb WHERE workspace_id = $1`, [ws]);
    site = await makeSpace(ws, `Site ${stamp}`, [{ id: solo.id, permission: "edit" }], { publish: true, external_ai: false, backup: true });
  });

  it("REST create: under a kept-off note it is kept off, and says why; under a published one it is as before", async () => {
    const { off, plain } = await parents();
    await expectInherited(await create("Child of off", { parent_id: off }));
    await expectUntouched(await create("Child of plain", { parent_id: plain }));
    await expectUntouched(await create("Top level"));
  });

  it("the reply to a create says the note's place on the site, so a stale drawing can be corrected", async () => {
    const { off, plain } = await parents();
    const reply = async (parent_id: string) => (await (await send(solo, "/api/nodes", "POST", { title: `R ${randomUUID().slice(0, 4)}`, markdown: "x", space_id: site, parent_id })).json()) as { attrs: Record<string, string> };
    expect((await reply(off)).attrs).toEqual({ _published: "false", _published_by_parent: "true" });
    expect((await reply(plain)).attrs).toEqual({});
  });

  it("a reconstructed note (a restore, another device's note) is not given the default; its writes chain to the creation", async () => {
    const { off } = await parents();
    const made = await createNote({ actor: solo, workspaceId: ws, title: "Restored", markdown: "x", parentId: off, siteDefault: false, event: { uiContext: "backup.restore" } });
    await expectUntouched(String(made.node.id));
    const inherited = await create("Chained", { parent_id: off });
    const rows = (await q<{ caused: string | null; created: string }>(
      `SELECT a.triggered_by_event_id::text AS caused, c.id::text AS created FROM domain_events a JOIN domain_events c ON c.target_id = a.target_id AND c.event_type = 'NODE_CREATED'
        WHERE a.target_id = $1 AND a.event_type = 'ATTRIBUTE_SET'`, [inherited])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.caused).toBe(row.created);
  });

  it("the agent's createNode goes the same way", async () => {
    const { off, plain } = await parents();
    const make = async (parent_id: string, title: string) => String((await createNode.handler({ title, markdown: "agent text", parent_id }, { actor: solo, workspaceId: ws, dryRun: false } as never)).id);
    await expectInherited(await make(off, "Agent under off"));
    await expectUntouched(await make(plain, "Agent under plain"));
  });

  it("import into a kept-off note, and a block made a child note, go the same way", async () => {
    const body = "第一段。\n\n要搬出去的一段。\n";
    const { off, plain } = await parents(body);
    const source = { id: randomUUID(), name: "parent-default" } as never;
    const imported = async (parentId: string, title: string) => {
      expect((await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path: `${randomUUID()}.md`, content: `---\ntitle: ${title}\n---\nbody` }, parentId, reuse: false })).status).toBe("imported");
      return (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [ws, title])).rows[0]!.id;
    };
    await expectInherited(await imported(off, "Imported under off"));
    await expectUntouched(await imported(plain, "Imported under plain"));
    // A file that says `publish: false` itself is the person's own mark: no "by parent" note on it.
    const own = await imported(plain, "Imported own off").then(async () => {
      const r = await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path: `${randomUUID()}.md`, content: "---\ntitle: Imported marked\npublish: false\n---\nbody" }, parentId: off, reuse: false });
      expect(r.status).toBe("imported");
      return (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = 'Imported marked'`, [ws])).rows[0]!.id;
    });
    expect(await flagOf(own)).toBe("false");
    expect(await markOf(own)).toBeNull();

    const move = async (noteId: string) => {
      const anchor = await ensureBlockAnchor(ws, noteId, body, body.indexOf("要搬出去"), { actor: solo });
      return String((await moveBlockToChildNote({ workspaceId: ws, actor: solo, noteId, blockRef: anchor!, fallbackTitle: `Child ${noteId.slice(0, 4)}`, keepIdentity: false })).childId);
    };
    await expectInherited(await move(off));
    await expectUntouched(await move(plain));
  });

  it("a copy of a note under a kept-off note is kept off by the same default; a copy under a published one is not", async () => {
    const { off, plain } = await parents();
    const underOff = await create("Copy source off", { parent_id: off });
    const underPlain = await create("Copy source plain", { parent_id: plain });
    await expectInherited(String((await duplicateNote({ workspaceId: ws, actor: solo, sourceId: underOff })).node.id));
    await expectUntouched(String((await duplicateNote({ workspaceId: ws, actor: solo, sourceId: underPlain })).node.id));
  });

  it("only the direct parent counts: a note put back under a kept-off one makes published children", async () => {
    const { off } = await parents();
    const middle = await create("Middle", { parent_id: off });
    await putBack(middle);
    expect(await onSite(middle)).toBe(true);
    await expectUntouched(await create("Grandchild", { parent_id: middle }));
  });

  it("notes that already exist are not changed, by the parent being marked afterwards, nor by moving", async () => {
    const parent = await create("Marked later");
    const before = await create("Made before", { parent_id: parent });
    await keepOff(parent);
    expect(await flagOf(before)).toBeNull();
    expect(await onSite(before)).toBe(true);
    const loose = await create("Moved in");
    expect((await send(solo, `/api/nodes/${loose}`, "PATCH", { parent_id: parent })).status).toBe(200);
    expect(await flagOf(loose)).toBeNull();
    expect(await onSite(loose)).toBe(true);
  });

  it("「放回網站」 puts the note on the site and takes the mark away; marking it again is then its own 「不發布」", async () => {
    const { off } = await parents();
    const child = await create("Put me back", { parent_id: off });
    await expectInherited(child);
    await putBack(child);
    expect(await markOf(child)).toBeNull();
    expect(await onSite(child)).toBe(true);
    await keepOff(child);
    expect(await flagOf(child)).toBe("false");
    expect(await markOf(child)).toBeNull();
  });

  it("the publish preview names the reason, and an ordinary 「不發布」 keeps its own", async () => {
    const { off } = await parents();
    const inherited = await create("Inherited note", { parent_id: off });
    const reasons = new Map((await leftOutNotes(ws, solo)).map((n) => [n.node_id, n.reason]));
    expect(reasons.get(inherited)).toBe("kept_off_by_parent");
    expect(reasons.get(off)).toBe("kept_off");
  });
});
