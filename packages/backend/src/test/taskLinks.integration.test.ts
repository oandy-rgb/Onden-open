// Tasks as link and embed targets (T6): a hidden #task node — a line's task
// or a standalone one with no parent — can be named by id in `[[…]]` /
// `![[…]]`, shows up in backlinks and in a search that asks for tasks, and
// never in the note tree. Reads go through the same read policy as any node.

import { beforeAll, describe, expect, it } from "vitest";
import { nodeRefTarget } from "@onden/markdown";
import { getWorkspaceId, q, withTransaction } from "../db.js";
import { searchNodes } from "../services/nodeSearch.js";
import { relinkTarget, syncWikilinkEdges } from "../services/wikilinkEdges.js";
import { markAsTask } from "./helpers/taskRef.js";
import { buildBootstrap } from "../services/sync/index.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("tasks as link targets (DB)", () => {
  let ws = "";
  let admin: ActorCtx = { id: "tl-admin", name: "TaskLinkAdmin", role: "admin", type: "human" };
  let viewer: ActorCtx = { id: "tl-viewer", name: "TaskLinkViewer", role: "viewer", type: "human" };
  let stamp = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    ws = await getWorkspaceId();
    admin = await persistActor(ws, admin);
    viewer = await persistActor(ws, viewer);
    stamp = `${Date.now()}`;
  });

  async function note(title: string, markdown = ""): Promise<string> {
    return (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,$4) RETURNING id::text`,
      [ws, title, `tl-${title.replace(/\W+/g, "-")}-${stamp}-${Math.random().toString(36).slice(2, 7)}`, markdown])).rows[0]!.id;
  }

  /** A hidden #task node. No `hostId` = standalone (no parent), the shape the
   *  task rework gives a task that belongs to no note. */
  async function task(title: string, hostId: string | null = null): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden)
       VALUES ($1,'manual','content',$2,$3,'',$4,true) RETURNING id::text`,
      [ws, title, `task-${Math.random().toString(36).slice(2)}${stamp}`, hostId])).rows[0]!.id;
    await markAsTask(ws, id);
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       VALUES ($1,$2,'_task_status','todo','text',false,'ui')`, [ws, id]);
    return id;
  }

  const edgeTargets = async (source: string) => (await q<{ t: string }>(
    `SELECT target_node_id::text t FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink'`, [source])).rows.map((r) => r.t);

  it("a link by id reaches that task, not another with the same title", async () => {
    const title = `Same name ${stamp}`;
    const first = await task(title);
    const second = await task(title, await note("Host"));
    const from = await note("Source");
    await withTransaction(() => syncWikilinkEdges(ws, from, `Do [[${nodeRefTarget(second)}|${title}]] now`));
    expect(await edgeTargets(from)).toEqual([second]);
    expect(await edgeTargets(from)).not.toContain(first);
  });

  it("a link by id is a backlink of a standalone task, and survives a re-derive", async () => {
    const id = await task(`Standalone ${stamp}`);
    const from = await note("Embeds", `![[${nodeRefTarget(id)}]]`);
    await withTransaction(() => syncWikilinkEdges(ws, from, `![[${nodeRefTarget(id)}]]`));
    expect(await edgeTargets(from)).toEqual([id]);
    // The target side (restored from the trash, renamed): edges are re-derived from the id spelling.
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [from, `![[${nodeRefTarget(id)}]]`]);
    await seedQ(`DELETE FROM node_edges WHERE source_node_id = $1`, [from]);
    await withTransaction(() => relinkTarget(ws, [id]));
    expect(await edgeTargets(from)).toEqual([id]);
  });

  it("a link by id reaches the node it spells and nothing for an unknown id", async () => {
    const other = await note("Not a task");
    const from = await note("Source 2");
    await withTransaction(() => syncWikilinkEdges(ws, from, `[[${nodeRefTarget(other)}]]`));
    expect(await edgeTargets(from)).toEqual([other]);
    await withTransaction(() => syncWikilinkEdges(ws, from, "[[onden://node/00000000-0000-4000-8000-000000000000]]"));
    expect(await edgeTargets(from)).toEqual([]);
  });

  it("search finds tasks only when asked, and marks them", async () => {
    const term = `zkqtasksearch${stamp}`;
    // A line's task (hosted): who may read a host-less task is the task rework's rule (T1).
    const t = await task(`${term} pay rent`, await note("Host of rent"));
    const n = await note(`${term} notes`, `about ${term}`);
    const plain = await searchNodes(ws, term, admin);
    expect(plain.map((r) => r.id)).toContain(n);
    expect(plain.map((r) => r.id)).not.toContain(t);
    const withTasks = await searchNodes(ws, term, admin, 30, { tasks: true });
    expect(withTasks.find((r) => r.id === t)?.is_task).toBe(true);
    expect(withTasks.find((r) => r.id === n)?.is_task).toBe(false);
  });

  it("a filter by the tasks module's tag name with tasks asked for finds task nodes through the tasks module's tag, which they no longer carry", async () => {
    const term = `zkqtagfilter${stamp}`;
    const tag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
       VALUES ($1,'manual','class_tag',$4,$2,'',$3) RETURNING id::text`,
      [ws, `module-task-${stamp}`, JSON.stringify({ name: `tf${stamp}`, slug: `module-task-${stamp}`, fields: [], module: "tasks" }), `tf${stamp}`])).rows[0]!.id;
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks', $2)`, [ws, tag]);
    const t = await task(`${term} pay rent`, await note("Host of filter"));
    const n = await note(`${term} notes`, `about ${term}`);
    const found = (await searchNodes(ws, `#tf${stamp} ${term}`, admin, 30, { tasks: true })).map((r) => r.id);
    expect(found).toContain(t);
    expect(found).not.toContain(n);
    // Without asking for tasks they stay out.
    expect((await searchNodes(ws, `#tf${stamp} ${term}`, admin)).map((r) => r.id)).not.toContain(t);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [tag]);
  });

  it("search for tasks stays inside what the caller may read", async () => {
    const term = `zkqprivtask${stamp}`;
    const host = await note(`Private host ${term}`);
    await putInSpace(host, await adminOnlySpace(ws, `tl-private-${stamp}`, [admin.id]));
    const t = await task(`${term} secret errand`, host);
    await seedQ(`UPDATE content_nodes SET space_id = (SELECT space_id FROM content_nodes WHERE id = $2) WHERE id = $1`, [t, host]);
    expect((await searchNodes(ws, term, admin, 30, { tasks: true })).map((r) => r.id)).toContain(t);
    expect((await searchNodes(ws, term, viewer, 30, { tasks: true })).map((r) => r.id)).not.toContain(t);
  });

  it("the note tree (bootstrap nodes) does not list tasks", async () => {
    const id = await task(`Tree check ${stamp}`);
    const payload = await buildBootstrap(admin, ws, { slimBodies: true });
    expect((payload.nodes as Array<{ id: string }>).map((n) => n.id)).not.toContain(id);
  });
});
