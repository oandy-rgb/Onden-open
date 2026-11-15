// Batch 0 acceptance (docs/architecture/proposals/block-anchors-2026-11-01.md §12), the save path:
//   * the positions and the text commit or roll back together — a failure AFTER the anchors moved
//     (here: the search/media hook at the end of applyBodyChange) leaves text, positions, hashes and
//     events exactly as they were;
//   * at most FIND_BUDGET anchors are looked up per save; the rest wait (maybe, pending) and the next save
//     finishes them.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { ensureBlockAnchor, FIND_BUDGET, listNoteAnchors } from "../services/blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const failure = vi.hoisted(() => ({ next: false }));
vi.mock("../services/nodeCommits.js", async (original) => {
  const real = await original<typeof import("../services/nodeCommits.js")>();
  return { ...real, nodeContentCommitted: async (...args: Parameters<typeof real.nodeContentCommitted>) => {
    if (failure.next) throw new Error("injected failure after the anchors moved");
    return real.nodeContentCommitted(...args);
  } };
});

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "anchors-save-admin", name: "Anchors", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const eventCount = async (id: string) => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE target_id = $1`, [id])).rows[0]!.n);

describe.skipIf(!isTestDb)("block anchors: the save path (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('AnchorsSave',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  async function noteWith(paragraphs: string[]): Promise<{ id: string; ids: string[] }> {
    const res = await send("/nodes", "POST", { title: `Save ${randomUUID().slice(0, 6)}`, markdown: paragraphs.join("\n\n") });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const body = await bodyOf(id);
    const ids: string[] = [];
    for (const p of paragraphs) ids.push((await ensureBlockAnchor(workspaceId, id, body, body.indexOf(p), { actor }))!);
    return { id, ids };
  }

  it("a failure after the anchors moved rolls back the text, the positions, the hashes and the events together", async () => {
    const A = "二分搜尋要先排序，再比較中間值，找不到就縮小範圍。";
    const B = "雜湊表用鍵直接算出位置，碰撞要另外處理，例如鏈結法。";
    const { id } = await noteWith([A, B]);
    const bodyBefore = await bodyOf(id);
    const anchorsBefore = await listNoteAnchors(workspaceId, id);
    const eventsBefore = await eventCount(id);
    const rowsBefore = (await q(`SELECT * FROM block_anchors WHERE note_id = $1 ORDER BY anchor_id`, [id])).rows;

    failure.next = true;
    // Deleting B moves one anchor (lost) and the other's hash; a failure at the end must undo all of it.
    const res = await send(`/nodes/${id}`, "PATCH", { markdown: "前言\n\n" + A });
    failure.next = false;
    expect(res.status).toBeGreaterThanOrEqual(500);

    expect(await bodyOf(id)).toBe(bodyBefore);
    expect(await listNoteAnchors(workspaceId, id)).toEqual(anchorsBefore);
    expect((await q(`SELECT * FROM block_anchors WHERE note_id = $1 ORDER BY anchor_id`, [id])).rows).toEqual(rowsBefore);
    expect(await eventCount(id)).toBe(eventsBefore);

    // The same save once the failure is gone: text and anchors move together.
    const ok = await send(`/nodes/${id}`, "PATCH", { markdown: "前言\n\n" + A });
    expect(ok.status).toBe(200);
    const after = await listNoteAnchors(workspaceId, id);
    expect(after.filter((a) => a.status === "lost")).toHaveLength(1);
    expect(after.every((a) => a.atBodyHash === after[0]!.atBodyHash)).toBe(true);
  });

  it("looks up at most FIND_BUDGET anchors per save; the rest wait and the next save finishes them", async () => {
    const paragraphs = Array.from({ length: FIND_BUDGET + 3 }, (_, i) => `第${i}條獨一無二的筆記內容：${"字".repeat(10 + i)}${i}`);
    const { id, ids } = await noteWith(paragraphs);
    // The body changes behind the anchors' back (a path not on applyBodyChange): every anchor now has a stale hash
    // and must be found again by its quote.
    const shifted = ["新加的一段在最前面", ...paragraphs].join("\n\n");
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [id, shifted]);

    expect((await send(`/nodes/${id}`, "PATCH", { markdown: shifted + "\n\n結尾" })).status).toBe(200);
    let anchors = await listNoteAnchors(workspaceId, id);
    expect(anchors.filter((a) => a.status === "valid")).toHaveLength(FIND_BUDGET);
    const waiting = anchors.filter((a) => a.recoveryPending);
    expect(waiting).toHaveLength(paragraphs.length - FIND_BUDGET);
    expect(waiting.every((a) => a.status === "maybe")).toBe(true); // never "valid" until looked up

    // The next save looks up the rest.
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: shifted + "\n\n結尾兩行" })).status).toBe(200);
    anchors = await listNoteAnchors(workspaceId, id);
    expect(anchors.every((a) => a.status === "valid" && !a.recoveryPending)).toBe(true);
    const body = await bodyOf(id);
    for (const [i, p] of paragraphs.entries()) {
      const a = anchors.find((x) => x.anchorId === ids[i])!;
      expect(body.slice(a.span.from, a.span.to)).toBe(p);
    }
  });
});
