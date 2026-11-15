// Soft deletion must not erase access rules (the note's space), while ordinary
// reads stay live-only.
// Run only on an isolated *_test database; the root test runner owns sequencing.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { event, getWorkspaceId, q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodeRouter from "../routes/nodes.js";
import { putBlob } from "../services/blobs.js";
import { canReadNode, canReadRetainedNode, readableTrashedNodeIds } from "../services/readPolicy.js";
import { assertAuthority, AuthorityError } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let admin: ActorCtx = { id: "retained-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "retained-viewer", name: "Viewer", role: "viewer", type: "human" };
let editor: ActorCtx = { id: "retained-editor", name: "Editor", role: "editor", type: "human" };
let currentActor = admin;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);

describe.skipIf(!isTestDb)("retained node policy (DB)", () => {
  let workspaceId = "";
  let secretSpace = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO NOTHING`);
    workspaceId = await getWorkspaceId();
    admin = await persistActor(workspaceId, admin);
    viewer = await persistActor(workspaceId, viewer);
    editor = await persistActor(workspaceId, editor);
    currentActor = admin;
    secretSpace = await adminOnlySpace(workspaceId, `retained-secret-${randomUUID()}`, [admin.id]);
  });

  const write = (actor: ActorCtx, nodeId: string, kind: "node" | "retained_node" = "node") =>
    assertAuthority(actor, { kind, nodeId, op: "write_node" }).then(() => true, (e) => {
      if (e instanceof AuthorityError) return false;
      throw e;
    });
  // A secret note lives in a space only the admin is in; children follow their parent's space.
  const node = async (options: { parent?: string; secret?: boolean; deleted?: boolean } = {}) => {
    const id = randomUUID();
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, deleted_at)
       VALUES ($1,$2,'manual','content',$3,$3,'retained secret body',$4,$5)`,
      [id, workspaceId, `retained-${id}`, options.parent ?? null, options.deleted ? new Date() : null],
    );
    if (options.secret) await putInSpace(id, secretSpace);
    return id;
  };

  it("missing/purged targets are denied; an existing untagged target allows editors, never viewers", async () => {
    const missing = randomUUID();
    expect(await canReadNode(admin, missing)).toBe(false);
    expect(await canReadRetainedNode(admin, missing)).toBe(false);
    currentActor = admin;
    expect((await app.request(`/api/nodes/${missing}`)).status).toBe(404);
    expect(await write(admin, missing, "retained_node")).toBe(false);
    const plain = await node();
    expect(await write(editor, plain)).toBe(true);
    expect(await write(viewer, plain)).toBe(false);
    await seedQ(`DELETE FROM content_nodes WHERE id=$1`, [plain]);
    expect(await write(admin, plain, "retained_node")).toBe(false);
  });

  it("history and attributes of a trashed node stay unavailable on ordinary read endpoints", async () => {
    const id = await node({ secret: true });
    const bodyHash = await putBlob(`RETAINED PRIVATE HISTORY ${id}`);
    await event(workspaceId, "NODE_CREATED", "node", id, { title: "Private", body_hash: bodyHash }, "user", admin.id);
    await event(workspaceId, "ATTRIBUTE_SET", "node", id, { key: "ink_data", value: `PRIVATE INK ${id}` }, "user", admin.id);
    await seedQ(
      `INSERT INTO node_attributes (workspace_id,node_id,key,value,value_type,source)
       VALUES ($1,$2,'secret','PRIVATE ATTRIBUTE','text','ui')`,
      [workspaceId, id],
    );
    currentActor = admin;
    expect((await app.request(`/api/nodes/${id}/versions?raw=1`)).status).toBe(200);
    currentActor = viewer;
    // Live but unreadable answers like missing (no existence probe).
    expect((await app.request(`/api/nodes/${id}`)).status).toBe(404);
    await seedQ(`UPDATE content_nodes SET deleted_at=now() WHERE id=$1`, [id]);
    for (const actor of [viewer, admin]) {
      currentActor = actor;
      expect((await app.request(`/api/nodes/${id}`)).status).toBe(404);
      for (const endpoint of ["versions?raw=1", "versions", "ink-versions", "ink-edits", "ink-change?after=1", "history", "attributes"]) {
        const response = await app.request(`/api/nodes/${id}/${endpoint}`);
        expect(response.status, `${actor.role} ${endpoint}`).toBe(404);
        expect(await response.text()).not.toContain("PRIVATE");
      }
    }
  });

  it("retained authority preserves the space of a trashed chain and the token's write access", async () => {
    const parent = await node({ secret: true, deleted: true });
    const child = await node({ parent, deleted: true });
    const authority = { kind: "retained_node", nodeId: child, op: "write_node" } as const;
    await expect(assertAuthority(viewer, authority)).rejects.toBeInstanceOf(AuthorityError);
    await expect(assertAuthority(admin, authority)).resolves.toBeUndefined();
    await expect(assertAuthority(admin, { ...authority, kind: "node" })).rejects.toBeInstanceOf(AuthorityError);

    // A token reaches its actor's memberships (admin is an editor of secretSpace);
    // it writes there only with write access.
    const token = { ...admin, tokenScope: { tokenId: "retained-token", allowedTools: null, access: "write" as const, writeMode: "apply" as const, expiresAt: null } };
    await expect(assertAuthority(token, authority)).resolves.toBeUndefined();
    await expect(assertAuthority({ ...token, tokenScope: { ...token.tokenScope, access: "read" as const } }, authority))
      .rejects.toBeInstanceOf(AuthorityError);
  });

  it("retained read rules agree with the trash listing on deleted ancestor chains", async () => {
    const parent = await node({ secret: true, deleted: true });
    const child = await node({ parent, deleted: true });
    const direct = await node({ secret: true, deleted: true });
    const plain = await node({ deleted: true });
    for (const actor of [viewer, admin]) {
      const visible = await readableTrashedNodeIds(actor, workspaceId);
      for (const id of [parent, child, direct, plain]) {
        expect(await canReadRetainedNode(actor, id)).toBe(visible.has(id));
        expect(await canReadNode(actor, id)).toBe(false);
      }
    }
    expect(await canReadRetainedNode(viewer, child)).toBe(false);
    expect(await canReadRetainedNode(viewer, plain)).toBe(true);
    expect(await canReadRetainedNode(admin, child)).toBe(true);
  });

  it("undelete rejects a forbidden actor without an event and permits an authorized actor", async () => {
    const id = await node({ secret: true, deleted: true });
    const restoredEvents = async () => (await q<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM domain_events WHERE workspace_id=$1 AND target_id=$2 AND event_type='NODE_UNDELETED'`,
      [workspaceId, id],
    )).rows[0]!.count;
    currentActor = viewer;
    expect((await app.request(`/api/nodes/${id}/undelete`, { method: "POST" })).status).toBe(403);
    expect(await restoredEvents()).toBe("0");
    currentActor = admin;
    const restored = await app.request(`/api/nodes/${id}/undelete`, { method: "POST" });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restoredEvents()).toBe("1");
    expect(await canReadNode(admin, id)).toBe(true);
    expect(await canReadNode(viewer, id)).toBe(false);
  });
});
