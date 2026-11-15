// GET /api/nodes/:id/versions 的新欄位（summary／markers／restored_from／actor_kind）。
// 純函式的案例在 noteVersions.test.ts；這裡驗證事件→列的整條路：建立、同一人連續編輯、
// agent 編輯、發布快照、版本還原，以及不可讀的筆記。
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
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

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
app.route("/api", publishRouter);
registerShippedModules();
const send = (url: string, method = "GET", body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });

type Summary = { added: number; changed: number; removed: number; sections: string[] };
type V = {
  id: string; markdown: string; saves: number; changed_at: string; actor_name: string | null; actor_type: string;
  actor_kind: "human" | "agent" | "system"; summary: Summary; markers: string[]; restored_from: string | null;
};

const V0 = "# 待辦\n\n- 買牛奶\n\n# 想法\n\n今天天氣很好，適合出門散步。";
const V1 = "# 待辦\n\n- 買牛奶\n- 繳電費\n\n# 想法\n\n今天天氣很好，適合出門散步。";
const V2 = "# 待辦\n\n- 買牛奶\n- 繳電費\n\n# 想法\n\n今天天氣很好，適合出門散步和運動。";
const V3 = `${V2}\n\n# 附註\n\nagent 補的一段。`;

describe.skipIf(!isTestDb)("note versions: summary / markers / restored_from / actor_kind", () => {
  let owner: ActorCtx;
  let bot: ActorCtx;
  let outsider: ActorCtx;
  let space = "";
  let nodeId = "";

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Versions',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, { id: "x", name: "Owner", role: "admin", type: "human" } as ActorCtx);
    bot = await persistActor(workspaceId, { id: "x", name: "Helper bot", role: "editor", type: "agent" } as ActorCtx);
    outsider = await persistActor(workspaceId, { id: "x", name: "Outsider", role: "editor", type: "human" } as ActorCtx);
    space = await makeSpace(workspaceId, `ver-${randomUUID()}`, [{ id: owner.id, role: "manager" }, { id: bot.id, role: "editor" }], { publish: true, external_ai: true, backup: true });
  });

  // 每個案例各自的筆記（案例順序會被打亂，restore 案例不能影響其他案例）
  beforeEach(async () => {
    currentActor = owner;
    const created = await send("/api/nodes", "POST", { space_id: space, title: `H1 ${randomUUID()}`, markdown: V0 });
    expect(created.status).toBeLessThan(300);
    nodeId = ((await created.json()) as { id: string }).id;
    // 兩次連續儲存 = 同一段；agent 之前先發布一次
    expect((await send(`/api/nodes/${nodeId}`, "PATCH", { markdown: V1 })).status).toBe(200);
    expect((await send(`/api/nodes/${nodeId}`, "PATCH", { markdown: V2 })).status).toBe(200);
    expect((await send(`/api/nodes/${nodeId}/attributes/_published`, "PUT", { value: "true", value_type: "bool" })).status).toBe(200);
    expect((await publishWithPreview((p, b) => send(p, "POST", b))).status).toBe(201);
    currentActor = bot;
    expect((await send(`/api/nodes/${nodeId}`, "PATCH", { markdown: V3 })).status).toBe(200);
    currentActor = owner;
  });

  const list = async () => (await (await send(`/api/nodes/${nodeId}/versions`)).json()) as V[];

  it("每一列都有 summary／markers／restored_from／actor_kind，並保留既有欄位", async () => {
    const versions = await list();
    expect(versions).toHaveLength(3); // 建立、我的連續儲存、agent
    for (const v of versions) {
      expect(v).toMatchObject({ id: expect.any(String), markdown: expect.any(String), saves: expect.any(Number), changed_at: expect.any(String) });
      expect(Array.isArray(v.markers)).toBe(true);
    }
    expect(versions.map((v) => v.actor_kind)).toEqual(["agent", "human", "human"]);
  });

  it("摘要與前一列（較舊）比較；最舊一列 added = 段落數", async () => {
    const [agent, mine, created] = await list();
    expect(created!.summary).toEqual({ added: 4, changed: 0, removed: 0, sections: [] });
    // V0 → V2：待辦新增 1 項、想法改了 1 段
    expect(mine!.saves).toBe(2);
    expect(mine!.summary).toEqual({ added: 1, changed: 1, removed: 0, sections: ["待辦", "想法"] });
    // V2 → V3：新增「附註」標題與內文
    expect(agent!.summary).toEqual({ added: 2, changed: 0, removed: 0, sections: ["附註"] });
  });

  it("markers：agent 之前的那一列是 before_agent；發布當時的那一列是 published:n", async () => {
    const [agent, mine, created] = await list();
    // n = 這個工作區第幾個快照；這篇的最新一次發布就是最大的那個
    const latest = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM publish_snapshots WHERE workspace_id = $1`, [workspaceId])).rows[0]!.n);
    expect(mine!.markers).toContain("before_agent");
    expect(mine!.markers).toContain(`published:${latest}`);
    expect(agent!.markers).toEqual([]);
    expect(created!.markers).toEqual([]);
  });

  it("還原產生新的一列：restored、restored_from 指向被還原那一列的 changed_at，並在還原後另成一列", async () => {
    const before = await list();
    const target = before[2]!; // 建立的那一版
    expect((await send(`/api/nodes/${nodeId}/versions/${target.id}/restore`, "POST")).status).toBeLessThan(300);
    const after = await list();
    expect(after).toHaveLength(4);
    expect(after[0]).toMatchObject({ markdown: V0, actor_kind: "human", restored_from: target.changed_at });
    expect(after[0]!.markers).toContain("restored");
    // 還原那一步與 V3（agent 的版本）相比：拿掉「繳電費」與「附註」兩段，想法那段改回
    expect(after[0]!.summary).toEqual({ added: 0, changed: 1, removed: 3, sections: expect.any(Array) });
    expect(after[1]!.markers).not.toContain("restored");
    expect(after[1]!.restored_from).toBeNull();
    // agent 的那一列現在不是最新，但 agent 之前的標記沒有被擠掉
    expect(after[2]!.markers).toContain("before_agent");
  });

  it("事件還原（restoreEvent）寫的更新也是「還原」，且自成一列", async () => {
    // agent 的那次儲存 → 還原它（回到 V2）
    const raw = (await (await send(`/api/nodes/${nodeId}/versions?raw=1`)).json()) as Array<{ id: string; actor_kind: string }>;
    const agentSave = raw.find((r) => r.actor_kind === "agent")!;
    const res = await send(`/api/events/${agentSave.id}/restore`, "POST");
    expect(res.status).toBe(200);
    const after = await list();
    expect(after).toHaveLength(4);
    expect(after[0]).toMatchObject({ markdown: V2, actor_kind: "human", saves: 1 });
    expect(after[0]!.markers).toContain("restored");
  });

  it("?raw=1 保留未合併的事件並多一個 actor_kind（沒有 summary）", async () => {
    const raw = (await (await send(`/api/nodes/${nodeId}/versions?raw=1`)).json()) as Array<Record<string, unknown>>;
    expect(raw.length).toBe(4); // 建立 + 兩次儲存 + agent
    expect(raw.every((r) => ["human", "agent", "system"].includes(r.actor_kind as string))).toBe(true);
    expect(raw.some((r) => r.actor_kind === "agent")).toBe(true);
    expect(raw[0]).not.toHaveProperty("summary");
  });

  it("不存在或不可讀的筆記 → 404（不洩漏存在與否）", async () => {
    expect((await send(`/api/nodes/00000000-0000-4000-8000-000000000000/versions`)).status).toBe(404);
    currentActor = outsider;
    expect((await send(`/api/nodes/${nodeId}/versions`)).status).toBe(404);
    expect((await send(`/api/nodes/${nodeId}/versions?raw=1`)).status).toBe(404);
  });
});
