// Anchor path through the real save path (PATCH → applyBodyChange → moveAnchorsForBodyChange, outbox recovery):
// two notes that start with the same body and the same anchors, saved along different paths to the same final text,
// must (in a path-independent design) hold the same anchor rows. The pure counterpart is anchorPath.test.ts;
// proposal docs/architecture/proposals/anchors-deterministic-2026-11-16.md. `it.fails` = differs today (cause on the line).
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { ChangeSet } from "@codemirror/state";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { anchorRowsForNotes, ensureBlockAnchor, FIND_BUDGET, listNoteAnchors, moveAnchorsForBodyChange, recoverAnchors, rehomeAnchor, blockSpanAt } from "../services/blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "anchor-path-admin", name: "AnchorPath", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const P = [
  "二分搜尋要先排序，再比較中間值，找不到就縮小範圍。",
  "雜湊表用鍵直接算出位置，碰撞要另外處理，例如鏈結法。",
  "圖的最短路徑可以用 Dijkstra，但是邊的權重不能是負數。",
  "動態規劃要先找出子問題，再記下答案避免重算。",
  "堆積可以快速取出最大值，插入和刪除都是對數時間。",
  "排序演算法裡快速排序平均最快，但最壞情況很慢。",
  "字串比對可以用 KMP，先建立失敗函式再掃描文字。",
  "平衡二元樹靠旋轉維持高度，查詢時間才穩定。",
];
const doc = (ps: string[]) => ps.join("\n\n");
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const patch = async (id: string, markdown: string, bodyChange?: ChangeSet) => {
  const res = await send(`/nodes/${id}`, "PATCH", { markdown, ...(bodyChange ? { body_change: { changes: bodyChange.toJSON(), device: "d1" } } : {}) });
  expect(res.status).toBe(200);
};

/** What the table keeps of a note's anchors, in the order the paragraphs were anchored (ids differ per note, so they are not compared). */
async function stateOf(noteId: string, ids: string[]) {
  const rows = await listNoteAnchors(workspaceId, noteId);
  return ids.map((id) => {
    const a = rows.find((r) => r.anchorId === id)!;
    return { span: a.span, quote: a.quote, status: a.status, candidate: a.candidate, recoveryPending: a.recoveryPending };
  });
}

describe.skipIf(!isTestDb)("anchor path through the save path (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('AnchorPath',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  async function note(paragraphs: string[]): Promise<{ id: string; ids: string[] }> {
    const res = await send("/nodes", "POST", { title: `Path ${randomUUID().slice(0, 6)}`, markdown: doc(paragraphs) });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const body = await bodyOf(id);
    const ids: string[] = [];
    for (const p of paragraphs) ids.push((await ensureBlockAnchor(workspaceId, id, body, body.indexOf(p), { actor }))!);
    return { id, ids };
  }

  const REWRITE = [
    P[1]!,
    "雜湊表用鍵直接算出位置，碰撞要另外處理，可以用鏈結。",
    "雜湊表用鍵直接算出位置，碰撞用開放定址，可以用鏈結。",
    "雜湊表用鍵直接算出位置，碰撞用開放定址，探測要小心。",
    "散列表用鍵直接算出位置，碰撞用開放定址，探測要小心。",
    "散列表把鍵算成位置，碰撞用開放定址，探測要小心。",
    "散列表把鍵算成位置，碰撞以開放定址法解決，探測宜小心。",
  ].map((r) => doc(P.map((p, i) => (i === 1 ? r : p))));

  it.fails("anchor path: the same final text by six PATCHes or by one — the paragraph stays valid in six, is lost in one (mapping.ts KEEP_MOVED against the refreshed quote)", async () => {
    const many = await note(P), one = await note(P);
    for (const v of REWRITE.slice(1)) await patch(many.id, v);
    await patch(one.id, REWRITE.at(-1)!);
    expect(await bodyOf(many.id)).toBe(await bodyOf(one.id));
    expect(await stateOf(one.id, one.ids)).toEqual(await stateOf(many.id, many.ids));
  });

  it.fails("anchor path: a character typed in front of a block of the same character — with the editor's ChangeSet vs without (mapping.ts changes(): editorChanges ?? deriveChangeSet)", async () => {
    const ten = "好好好好好好好好好好", start = doc(["前", ten, "後"]);
    const withCs = await note(["前", ten, "後"]), without = await note(["前", ten, "後"]);
    const at = start.indexOf(ten), next = start.slice(0, at) + "好" + start.slice(at);
    await patch(withCs.id, next, ChangeSet.of({ from: at, insert: "好" }, start.length));
    await patch(without.id, next);
    expect(await stateOf(without.id, without.ids)).toEqual(await stateOf(withCs.id, withCs.ids));
  });

  describe("eight paragraphs reversed", () => {
    const reversed = doc([...P].reverse());
    async function bubbled() {
      const n = await note(P);
      let cur = [...P];
      for (let i = 0; i < cur.length; i++) for (let j = 0; j < cur.length - 1 - i; j++) {
        [cur[j], cur[j + 1]] = [cur[j + 1]!, cur[j]!];
        await patch(n.id, doc(cur));
      }
      expect(await bodyOf(n.id)).toBe(reversed);
      return n;
    }
    it.fails("anchor path: in one PATCH some anchors stay maybe+pending (over FIND_BUDGET), moved a step at a time none do — before the pass", async () => {
      const one = await note(P);
      // An untrusted body (positions not measured on it), as a body that arrived by another route would be.
      await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [one.id, reversed]);
      await patch(one.id, `${reversed}\n`);
      const many = await bubbled();
      expect((await stateOf(one.id, one.ids)).map((a) => a.recoveryPending)).toEqual((await stateOf(many.id, many.ids)).map((a) => a.recoveryPending));
    });
    it("anchor path: after the recovery pass the one-PATCH note holds the same status per paragraph as the stepwise note", async () => {
      const one = await note(P);
      await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [one.id, reversed]);
      await patch(one.id, `${reversed}\n`);
      await recoverAnchors(workspaceId, one.id);
      const many = await bubbled();
      const text = await bodyOf(one.id);
      const a = await stateOf(one.id, one.ids), b = await stateOf(many.id, many.ids);
      expect(a.map((x) => [x.status, x.recoveryPending])).toEqual(b.map((x) => [x.status, x.recoveryPending]));
      // The one-PATCH note's body has the trailing newline the test added; the quotes are the same text.
      expect(a.map((x) => x.quote.text)).toEqual(b.map((x) => x.quote.text));
      expect(a.every((x) => text.slice(x.span.from, x.span.to) === x.quote.text)).toBe(true);
    });
  });

  it("a note with more lost anchors than FIND_BUDGET settles: the background pass ends, and a later save leaves nothing pending", async () => {
    const n = await note(P);
    await patch(n.id, doc([P[0]!, P[1]!])); // six of eight paragraphs deleted: five lost, the sixth over the budget
    const lostAfterSave = (await stateOf(n.id, n.ids)).filter((a) => a.status === "lost").length;
    expect(lostAfterSave).toBe(FIND_BUDGET);
    await recoverAnchors(workspaceId, n.id); // used to throw after MAX_PASSES: the same five lost anchors took the whole budget every pass
    const settled = await stateOf(n.id, n.ids);
    expect(settled.filter((a) => a.status === "lost")).toHaveLength(6);
    expect(settled.some((a) => a.recoveryPending)).toBe(false);
    // The body changed, so the lost anchors are looked up again (a text may have come back): the one over the budget waits for the pass, which then ends too.
    await patch(n.id, doc([P[0]!, P[1]! + "再補一句。"]));
    await recoverAnchors(workspaceId, n.id);
    expect((await stateOf(n.id, n.ids)).some((a) => a.recoveryPending)).toBe(false);
  });

  it("a paragraph put back by hand (what 「救回」 writes) is found again by the save that puts it back: valid at its old id, and the link reads it as a part again", async () => {
    const n = await note(P);
    const original = await bodyOf(n.id);
    await patch(n.id, doc(P.filter((_, i) => i !== 3)));
    expect((await stateOf(n.id, n.ids))[3]).toMatchObject({ status: "lost", span: { from: 0, to: 0 } });
    await patch(n.id, original);
    const back = await stateOf(n.id, n.ids);
    expect(back[3]).toMatchObject({ status: "valid", recoveryPending: false });
    const wire = (await anchorRowsForNotes(workspaceId, [n.id])).find((r) => r.anchor_id === n.ids[3])!;
    expect(wire).toMatchObject({ status: "valid", from: original.indexOf(P[3]!), to: original.indexOf(P[3]!) + P[3]!.length });
  });

  it("a lost anchor the person points at a paragraph (重新指定) is valid, is measured on the body it was pointed on, and the next save follows it", async () => {
    const n = await note(P);
    await patch(n.id, doc(P.filter((_, i) => i !== 3)));
    const body = await bodyOf(n.id);
    expect((await stateOf(n.id, n.ids))[3]!.status).toBe("lost");
    const at = body.indexOf(P[5]!);
    expect(await rehomeAnchor(workspaceId, n.ids[3]!, n.id, body, blockSpanAt(body, at)!)).toBe(true);
    await patch(n.id, "新的第一行\n\n" + body);
    const moved = (await stateOf(n.id, n.ids))[3]!;
    expect(moved.status).toBe("valid");
    const next = await bodyOf(n.id);
    expect(next.slice(moved.span.from, moved.span.to)).toBe(P[5]);
  });

  it("a note with 18 lost anchors (far over the budget): the pass ends, the same body saved again looks up nothing and queues nothing, and no job failed", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `獨一無二的第${i}條筆記內容：${"字詞".repeat(5 + i)}${i}。`);
    const n = await note(many);
    await patch(n.id, doc(many.slice(0, 2)));
    await recoverAnchors(workspaceId, n.id);
    const settled = await stateOf(n.id, n.ids);
    expect(settled.filter((a) => a.status === "lost")).toHaveLength(18);
    expect(settled.some((a) => a.recoveryPending)).toBe(false);
    const jobs = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE effect_kind = 'block_anchor_recover' AND payload->>'note_id' = $1`, [n.id])).rows[0]!.n;
    const before = await jobs();
    const body = await bodyOf(n.id);
    const again = await moveAnchorsForBodyChange({ workspaceId, noteId: n.id, before: body, after: body });
    expect(again).toMatchObject({ moved: 0, pending: 0 });
    expect(await jobs()).toBe(before);
    expect((await q(`SELECT 1 FROM outbox WHERE effect_kind = 'block_anchor_recover' AND last_error IS NOT NULL`)).rowCount).toBe(0);
  });
});
