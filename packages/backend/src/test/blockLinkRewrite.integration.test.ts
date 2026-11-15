// Old part links `[[筆記#^id]]` become `[[筆記/段落開頭]]` with a binding (services/blockLinkRewrite.ts), by the same
// system job that moves `^id` out of the text; idempotent, `updated_at` untouched, what it cannot be sure of is
// left and counted; the way back writes `[[筆記#^id]]` again.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { repairBlockMarkers, revertBlockIdMarks } from "../services/blockMarkerRepair.js";
import { seedQ } from "./helpers/seedQ.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
registerShippedModules();

const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const updatedAt = async (id: string) => String((await q<{ u: string }>(`SELECT updated_at::text AS u FROM content_nodes WHERE id = $1`, [id])).rows[0]!.u);
const bindingsOf = async (id: string) => (await q<{ link_text: string; anchor_id: string }>(
  `SELECT link_text, anchor_id FROM block_link_bindings WHERE note_id = $1 ORDER BY link_text`, [id])).rows;
const eventCount = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.n);

async function note(title: string, markdown: string, opts: { space?: string; legacy?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, anchor_form, space_id)
           VALUES ($1, $2, 'manual', 'content', $3, $4, $5, $6, $7)`,
    [id, workspaceId, title, `s-${id.slice(0, 8)}`, markdown, opts.legacy === false ? 1 : 0, opts.space ?? null]);
  return id;
}

describe.skipIf(!isTestDb)("old part links are rewritten (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('BlockLinkRewrite',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
  });

  it("[[筆記#^id]] becomes [[筆記/開頭]] with its binding; alias, embed and the rest stay; again changes nothing; the way back restores", async () => {
    const tag = randomUUID().slice(0, 6);
    const target = await note(`目標-${tag}`, `二分搜尋要先排序 ^aa${tag}\n\n另一段 ^bb${tag}\n`);
    const source = await note(`來源-${tag}`, `見 [[目標-${tag}#^aa${tag}|那段]]、![[目標-${tag}#^aa${tag}]]、[[目標-${tag}#^zz${tag}]]、[[目標-${tag}#標題]]。\n`);
    const stamp = await updatedAt(source);

    const report = await repairBlockMarkers({ workspaceId });
    expect(await bodyOf(target)).toBe("二分搜尋要先排序\n\n另一段\n");
    expect(await bodyOf(source)).toBe(`見 [[目標-${tag}/二分搜尋要先排序|那段]]、![[目標-${tag}/二分搜尋要先排序]]、[[目標-${tag}#^zz${tag}]]、[[目標-${tag}#標題]]。\n`);
    expect(await bindingsOf(source)).toEqual([{ link_text: `目標-${tag}/二分搜尋要先排序`, anchor_id: `aa${tag}` }]);
    expect(await updatedAt(source)).toBe(stamp);
    // What it could not decide is counted, not guessed: `zz` is no anchor.
    expect(report.links.left).toContainEqual({ workspaceId, noteId: source, reason: "target_not_found", links: 1 });
    expect(report.links.linksRewritten).toBeGreaterThanOrEqual(2);

    // Idempotent: the rewritten links have nothing left to find; the one that could not be decided is asked about again, writes nothing.
    const events = await eventCount();
    const again = await repairBlockMarkers({ workspaceId });
    expect(again.links.linksRewritten).toBe(0);
    expect(await eventCount()).toBe(events);

    // The way back writes the `^id` marks and the old links again (the older app reads only those).
    const back = await revertBlockIdMarks({ workspaceId });
    expect(back.left).toEqual([]);
    expect(await bodyOf(target)).toBe(`二分搜尋要先排序 ^aa${tag}\n\n另一段 ^bb${tag}\n`);
    expect(await bodyOf(source)).toBe(`見 [[目標-${tag}#^aa${tag}|那段]]、![[目標-${tag}#^aa${tag}]]、[[目標-${tag}#^zz${tag}]]、[[目標-${tag}#標題]]。\n`);
    expect(await updatedAt(source)).toBe(stamp);
  });

  it("two paragraphs that begin alike get distinct link words, each bound to its own anchor", async () => {
    const tag = randomUUID().slice(0, 6);
    const target = await note(`雙胞胎-${tag}`, `同樣的開頭 甲 ^ca${tag}\n\n同樣的開頭 乙 ^cb${tag}\n`);
    const source = await note(`連結-${tag}`, `[[雙胞胎-${tag}#^ca${tag}]] 與 [[雙胞胎-${tag}#^cb${tag}]]\n`);
    await repairBlockMarkers({ workspaceId });
    const body = await bodyOf(source);
    expect(body).not.toContain("#^");
    const bound = await bindingsOf(source);
    expect(bound.map((b) => b.anchor_id).sort()).toEqual([`ca${tag}`, `cb${tag}`]);
    expect(new Set(bound.map((b) => b.link_text)).size).toBe(2);
    void target;
  });

  it("a paragraph in another space is not named in this note (its words would be shown to other readers)", async () => {
    const tag = randomUUID().slice(0, 6);
    const spaceA = await makeSpace(workspaceId, `A-${tag}`, []);
    const spaceB = await makeSpace(workspaceId, `B-${tag}`, []);
    await note(`私有-${tag}`, `不該外洩的句子 ^dd${tag}\n`, { space: spaceA });
    const source = await note(`公開-${tag}`, `見 [[私有-${tag}#^dd${tag}]]\n`, { space: spaceB });
    const report = await repairBlockMarkers({ workspaceId });
    expect(await bodyOf(source)).toBe(`見 [[私有-${tag}#^dd${tag}]]\n`);
    expect(report.links.left).toContainEqual({ workspaceId, noteId: source, reason: "other_space", links: 1 });
    expect(await bindingsOf(source)).toEqual([]);
  });

  it("a paragraph without words (a picture) stays as it was", async () => {
    const tag = randomUUID().slice(0, 6);
    const target = await note(`圖片-${tag}`, `![](https://example.com/a.png) ^ee${tag}\n`);
    const source = await note(`參照-${tag}`, `[[圖片-${tag}#^ee${tag}]]\n`);
    const report = await repairBlockMarkers({ workspaceId });
    expect(await bodyOf(source)).toBe(`[[圖片-${tag}#^ee${tag}]]\n`);
    expect(report.links.left.filter((l) => l.noteId === source).map((l) => l.reason)).toEqual(["no_words"]);
    void target;
  });
});
