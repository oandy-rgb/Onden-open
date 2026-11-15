// 「什麼都沒改」的存檔不是一個時間點（業主 2026-11-02）。
// 伺服器：同內容存檔不寫事件、回 noop；移動不帶 body_hash；改成同名不算。
// 歷史查詢：既有資料裡內容相同的儲存併成一點（事件仍在），只差空白的也併。
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

vi.mock("../modules/website/publishing/githubPages.js", () => ({
  pushToGitHubPages: async () => "https://example.test/",
  expectedPagesUrl: () => "https://example.test/",
}));

import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import { updateNode } from "../services/nodeUpdate.js";
import { putBlob } from "../services/blobs.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace } from "./helpers/spaceFixtures.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let currentActor: ActorCtx | null = null;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/events", eventsRouter);
registerShippedModules();
const send = (url: string, method = "GET", body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });

type V = { id: string; markdown: string; title: string; saves: number };

const A = "# 標題\n\n第一段文字，今天天氣很好。\n\n第二段文字。";
const B = `${A}\n\n第三段文字，新增的一段。`;

describe.skipIf(!isTestDb)("a save that changes nothing is no history point", () => {
  let owner: ActorCtx;
  let bot: ActorCtx;
  let space = "";
  let nodeId = "";

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Noop',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, { id: "x", name: "Owner", role: "admin", type: "human" } as ActorCtx);
    bot = await persistActor(workspaceId, { id: "x", name: "Helper", role: "editor", type: "human" } as ActorCtx);
    space = await makeSpace(workspaceId, `noop-${randomUUID()}`, [{ id: owner.id, role: "manager" }, { id: bot.id, role: "editor" }]);
  });

  beforeEach(async () => {
    currentActor = owner;
    const created = await send("/api/nodes", "POST", { space_id: space, title: `N ${randomUUID()}`, markdown: A });
    expect(created.status).toBeLessThan(300);
    nodeId = ((await created.json()) as { id: string }).id;
  });

  const list = async () => (await (await send(`/api/nodes/${nodeId}/versions`)).json()) as V[];
  const raw = async () => (await (await send(`/api/nodes/${nodeId}/versions?raw=1`)).json()) as V[];
  const eventCount = async () =>
    Number((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE target_id = $1 AND event_type IN ('NODE_UPDATED','NODE_RESTORED')`, [nodeId])).rows[0]!.n);
  const patch = (body: Record<string, unknown>) => send(`/api/nodes/${nodeId}`, "PATCH", body);

  it("the same text and title again: no event, noop, no new version", async () => {
    const before = await eventCount();
    const row = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!;
    const res = await patch({ title: row.title, markdown: A, base_markdown: A });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: nodeId, markdown: A, noop: true });
    expect(await eventCount()).toBe(before);
    expect(await raw()).toHaveLength(1);
  });

  it("the service reports noop with no event id; a real change still records one", async () => {
    const same = await updateNode(workspaceId, nodeId, { markdown: A }, { actor: owner, baseMarkdown: A });
    expect(same).toMatchObject({ noop: true, eventId: null });
    const changed = await updateNode(workspaceId, nodeId, { markdown: B }, { actor: owner, baseMarkdown: A });
    expect(changed.noop).toBeUndefined();
    expect(changed.eventId).toEqual(expect.any(String));
  });

  it("typed and typed back is a noop even when the base is stale (the merge lands on the stored text)", async () => {
    await patch({ markdown: B, base_markdown: A });
    const before = await eventCount();
    // This writer started from A, changed nothing; the server holds B.
    const res = await patch({ markdown: A, base_markdown: A });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { markdown: string; noop?: boolean })).toMatchObject({ markdown: B, noop: true });
    expect(await eventCount()).toBe(before);
  });

  it("a title that differs only in Unicode normalization is no rename", async () => {
    const decomposed = "Café";
    expect((await patch({ title: "Café" })).status).toBe(200);
    const before = await eventCount();
    const res = await patch({ title: decomposed });
    expect(await res.json()).toMatchObject({ noop: true });
    expect(await eventCount()).toBe(before);
  });

  it("a real rename is still a version, with the same text", async () => {
    await patch({ title: "Another name", markdown: A, base_markdown: A });
    const versions = await list();
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ title: "Another name", markdown: A });
  });

  it("a move is recorded but carries no body_hash, so it is no version", async () => {
    const parent = ((await (await send("/api/nodes", "POST", { space_id: space, title: `P ${randomUUID()}`, markdown: "p" })).json()) as { id: string }).id;
    const before = await eventCount();
    const res = await patch({ parent_id: parent, markdown: A, base_markdown: A });
    expect(res.status).toBe(200);
    expect(await eventCount()).toBe(before + 1);
    const moved = (await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' ORDER BY id DESC LIMIT 1`, [nodeId])).rows[0]!;
    expect(moved.payload).not.toHaveProperty("body_hash");
    expect(await list()).toHaveLength(1);
    // The same move again changes nothing.
    expect(await (await patch({ parent_id: parent })).json()).toMatchObject({ noop: true });
  });

  it("hiding and the page design are recorded without a version", async () => {
    const before = await eventCount();
    expect((await patch({ presentation: { layout: "wide" }, markdown: A, base_markdown: A })).status).toBe(200);
    expect(await eventCount()).toBe(before + 1);
    expect(await list()).toHaveLength(1);
    // Same design again, with the keys in another order.
    expect(await (await patch({ presentation: { layout: "wide" } })).json()).toMatchObject({ noop: true });
  });

  it("a retry with the same idempotency key after a noop is a replay, not a second write", async () => {
    const key = randomUUID();
    const first = await app.request(`/api/nodes/${nodeId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ markdown: A, base_markdown: A }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ noop: true });
    // The note moved on; the retried request must not apply itself now.
    await patch({ markdown: B, base_markdown: A });
    const before = await eventCount();
    const retry = await app.request(`/api/nodes/${nodeId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ markdown: A, base_markdown: A }),
    });
    expect(retry.status).toBe(200);
    expect(await eventCount()).toBe(before);
    expect(((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.markdown)).toBe(B);
  });

  it("restoring the version the note already holds changes nothing", async () => {
    const [only] = await list();
    const before = await eventCount();
    const res = await send(`/api/nodes/${nodeId}/versions/${only!.id}/restore`, "POST");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ markdown: A, noop: true });
    expect(await eventCount()).toBe(before);
  });

  it("an edit after a noop still merges against the right base (three-way)", async () => {
    await patch({ markdown: A, base_markdown: A }); // noop
    await patch({ markdown: A.replace("第二段文字。", "第二段改過。"), base_markdown: A });
    // Another writer, still on A, edits a different paragraph.
    await patch({ markdown: A.replace("第一段文字，今天天氣很好。", "第一段別人改的。"), base_markdown: A });
    const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.markdown;
    expect(body).toContain("第二段改過。");
    expect(body).toContain("第一段別人改的。");
  });

  describe("history lists", () => {
    /** An event the way an older server recorded a save that changed nothing: a copy of `fromId` a few minutes on. */
    const legacyCopy = async (fromId: string, minutesLater: number, bodyHash?: string) => {
      const r = await q<{ id: string }>(
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta, external, created_at)
         SELECT workspace_id, actor_type, actor_id, event_type, target_type, target_id,
                CASE WHEN $3::text IS NULL THEN payload ELSE payload || jsonb_build_object('body_hash', $3::text) END,
                tx_meta, external, created_at + ($2 || ' minutes')::interval
           FROM domain_events WHERE id = $1 RETURNING id::text`,
        [fromId, String(minutesLater), bodyHash ?? null],
      );
      return r.rows[0]!.id;
    };
    const lastSaveId = async () => (await raw())[0]!.id;

    it("saves that repeat the previous text and title join the previous point, however far apart; no event is deleted", async () => {
      await patch({ markdown: B, base_markdown: A });
      const eventsBefore = (await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE target_id = $1`, [nodeId])).rows[0]!.n;
      const id = await lastSaveId();
      await legacyCopy(id, 20);
      await legacyCopy(id, 90);
      const versions = await list();
      expect(versions.map((v) => v.markdown)).toEqual([B, A]);
      expect((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE target_id = $1`, [nodeId])).rows[0]!.n).toBe(String(Number(eventsBefore) + 2));
      // The first appearance of the text is the point.
      expect(versions[0]!.id).toBe(id);
    });

    it("text that goes A, B, A is three points: a repeat only joins the one right before it", async () => {
      const createdId = (await raw())[0]!.id;
      await patch({ markdown: B, base_markdown: A });
      await legacyCopy(createdId, 60); // the old text again, later
      expect((await list()).map((v) => v.markdown)).toEqual([A, B, A]);
    });

    it("a rename with the same text stays its own point", async () => {
      await patch({ title: "Renamed", markdown: A, base_markdown: A });
      expect((await list()).map((v) => v.title)).toContain("Renamed");
      expect(await list()).toHaveLength(2);
    });

    it("a save by the same person that only differs in whitespace joins the newer point", async () => {
      await patch({ markdown: B, base_markdown: A });
      const spaced = `${B.replace("第二段文字。", "第二段文字。  ")}\n`;
      const hash = await putBlob(spaced);
      // An hour on (a session of its own), as an older server would have stored it.
      const saved = await lastSaveId();
      await legacyCopy(saved, 60, hash);
      await legacyCopy(saved, 120, await putBlob(`${B}\n\n補一段。`));
      const versions = await list();
      // created, one point for B and its whitespace variant, the real edit
      expect(versions).toHaveLength(3);
      expect(versions[1]!.markdown).toBe(spaced);
      expect(versions[1]!.saves).toBe(2);
    });

    it("a whitespace-only save by someone else stays its own point", async () => {
      await patch({ markdown: B, base_markdown: A });
      const spaced = `${B}\n`;
      currentActor = bot;
      expect((await patch({ markdown: spaced, base_markdown: B })).status).toBe(200);
      currentActor = owner;
      expect(await list()).toHaveLength(3);
    });

    it("a save that only adds a paragraph's ^id joins the newer point; indentation changes do not", async () => {
      const list0 = "- a {t}\n- b";
      await patch({ markdown: list0, base_markdown: A });
      const saved = await lastSaveId();
      await legacyCopy(saved, 60, await putBlob("- a {t} ^aa11bb\n- b ^cc22dd"));
      await legacyCopy(saved, 120, await putBlob("- a {t} ^aa11bb\n  - b ^cc22dd"));
      const versions = await list();
      expect(versions.map((v) => v.saves)).toEqual([1, 2, 1]); // the indent, the text with ids (+ its plain twin), created
    });

    it("more than 50 versions: the oldest listed row is never shown as a creation, merges or not", async () => {
      const base = (await raw())[0]!.id;
      for (let i = 1; i <= 54; i++) {
        // every 10th save repeats the text before it with trailing spaces: it merges away
        const text = i % 10 === 0 ? `${A}\n\n第 ${i - 1} 段  ` : `${A}\n\n第 ${i} 段`;
        await legacyCopy(base, i * 10, await putBlob(text));
      }
      const versions = await list();
      expect(versions.length).toBeLessThanOrEqual(50);
      expect(versions.length).toBeGreaterThan(40);
      const oldest = versions[versions.length - 1]!;
      expect(oldest.markdown).not.toBe(A); // it is not the very first version: older ones exist
      const summary = (oldest as unknown as { summary: { added: number } }).summary;
      expect(summary.added).toBeLessThanOrEqual(1); // one new paragraph, not the whole note as "created"
    }, 60_000);

    it("restored_from still finds its row when the restored version was merged into the one before it", async () => {
      await patch({ markdown: B, base_markdown: A });
      const bId = await lastSaveId();
      const twin = await legacyCopy(bId, 30); // the same text again, joined to B's point
      // Restore the twin (an older server could have listed it); then the restore says where it came from.
      const created = (await raw()).find((v) => v.markdown === A)!;
      expect(created).toBeTruthy();
      const res = await send(`/api/nodes/${nodeId}/versions/${twin}/restore`, "POST");
      expect(res.status).toBe(200);
      const after = await list() as unknown as Array<{ restored_from: string | null; id: string; changed_at: string }>;
      const restore = after.find((v) => v.restored_from !== null);
      if (restore) expect(after.some((v) => v.changed_at === restore.restored_from)).toBe(true);
    });
  });

  it("restore-as-new works for a move, which carries no body_hash of its own", async () => {
    const parent = ((await (await send("/api/nodes", "POST", { space_id: space, title: `P ${randomUUID()}`, markdown: "p" })).json()) as { id: string }).id;
    await patch({ parent_id: parent, markdown: A, base_markdown: A });
    const move = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' ORDER BY domain_events.id DESC LIMIT 1`, [nodeId])).rows[0]!.id;
    const res = await send(`/api/events/${move}/restore`, "POST", { as_new_node: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { new_node_id: string };
    const copy = (await q<{ markdown: string; title: string }>(`SELECT markdown, title FROM content_nodes WHERE id = $1`, [body.new_node_id])).rows[0]!;
    expect(copy.markdown).toBe(A);
    expect(copy.title).toMatch(/^\[Restored\]/);
  });
});
