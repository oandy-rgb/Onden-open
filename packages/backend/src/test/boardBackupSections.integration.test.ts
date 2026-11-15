// A board's section frames and cards through a backup and a restore (whiteboard review 2026-11-11,
// docs/archive/deep-review-board-2026-11-11.md). Same harness as backupWorkspaceMove.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";

let current = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => current }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import nodesRouter from "../routes/nodes.js";
import boardsRouter from "../routes/boards.js";
import type { RestoreJob } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForJob } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.route("/api/nodes", nodesRouter);
  hono.route("/api/boards", boardsRouter);
  return hono;
}
const send = (a: ActorCtx, url: string, method: string, body: unknown = {}) =>
  app(a).request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function newWorkspace(name: string) {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `${name}-${randomUUID()}`])).rows[0]!.id;
  current = ws;
  const owner = await persistActor(ws, { id: "", name: `Owner of ${name}`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, owner.id);
  const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [owner.id])).rows[0]!.id;
  return { ws, owner, personal };
}

describe.skipIf(!isTestDatabase())("a board through backup and restore", () => {
  let target: Awaited<ReturnType<typeof newWorkspace>>;
  let source: Awaited<ReturnType<typeof newWorkspace>>;
  let boardTitle = "";
  let zip: Buffer;
  const restore = async (side: typeof source, mode: string) => {
    current = side.ws;
    const up = await app(side.owner).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const id = ((await up.json()) as { upload_id: string }).upload_id;
    const started = await send(side.owner, `/api/backup/restore/${id}/apply`, "POST", { space_id: side.personal, mode });
    const job = await waitForJob(app(side.owner), ((await started.json()) as { job: RestoreJob }).job);
    expect(job.status, JSON.stringify(job)).toBe("done");
  };
  const readBoard = async (side: typeof source, title = boardTitle) => {
    current = side.ws;
    const id = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [side.ws, title])).rows[0]!.id;
    const res = await app(side.owner).request(`/api/boards/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { cards: Array<{ nodeId: string; x: number; y: number; width?: number; color?: string }>; sections: Array<{ id: string; title?: string; x: number; color?: string }> };
  };

  beforeAll(async () => {
    source = await newWorkspace("board-src");
    current = source.ws;
    const create = async (title: string) => ((await (await send(source.owner, "/api/nodes", "POST", { title, markdown: "x\n" })).json()) as { id: string }).id;
    boardTitle = `Board ${randomUUID()}`;
    const board = await create(boardTitle);
    const card = await create("Card");
    const patch = await send(source.owner, `/api/boards/${board}`, "PATCH", {
      cards: { upsert: [{ nodeId: card, x: 11, y: 22, width: 300, color: "#ef4444" }] },
      sections: { upsert: [{ id: "s1", title: "Group A", x: 0, y: 0, width: 500, height: 400, color: "#22c55e" }] },
    });
    expect(patch.status).toBe(200);
    zip = Buffer.from(await (await app(source.owner).request("/api/backup/full.zip")).arrayBuffer());
    target = await newWorkspace("board-dst");
    await restore(target, "workspace");
  });

  it("the cards keep their place, size and colour", async () => {
    const restored = await readBoard(target);
    expect(restored.cards).toEqual([expect.objectContaining({ x: 11, y: 22, width: 300, color: "#ef4444" })]);
  });

  it("the section frames (groups) come back with the board", async () => {
    const restored = await readBoard(target);
    expect(restored.sections).toEqual([expect.objectContaining({ id: "s1", title: "Group A", x: 0, color: "#22c55e" })]);
  });

  it("restoring into the original workspace twice leaves an unchanged board's frames alone", async () => {
    current = source.ws;
    const boardId = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [source.ws, boardTitle])).rows[0]!.id;
    const edit = await send(source.owner, `/api/boards/${boardId}`, "PATCH", { sections: { upsert: [{ id: "s1", title: "Renamed", x: 0, y: 0, width: 500, height: 400 }] } });
    expect(edit.status).toBe(200);
    await restore(source, "merge");
    await restore(source, "merge");
    expect((await readBoard(source)).sections.map((s) => s.title)).toEqual(["Renamed"]);
  });

  it("a backup copy of a changed board carries the backed-up frames", async () => {
    current = source.ws;
    const boardId = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [source.ws, boardTitle])).rows[0]!.id;
    const edit = await send(source.owner, `/api/nodes/${boardId}`, "PATCH", { markdown: "changed body\n" });
    expect(edit.status).toBe(200);
    const before = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [source.ws, boardTitle])).rows.length;
    await restore(source, "merge");
    const boards = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2 AND id <> $3 AND deleted_at IS NULL`, [source.ws, `%${boardTitle}%`, boardId])).rows;
    expect(boards.length).toBe(1);
    expect(before).toBe(1);
    const copy = (await (await app(source.owner).request(`/api/boards/${boards[0]!.id}`)).json()) as { sections: Array<{ id: string; title?: string; color?: string }> };
    expect(copy.sections).toEqual([expect.objectContaining({ id: "s1", title: "Group A", color: "#22c55e" })]);
  });
});
