// P2 tag merge: fold #source into #target with full apply semantics and
// Trash-grade reversibility (source soft-deleted, junction rows survive).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { memberTagIds } from "../services/tagHierarchy.js";
import { functionIndex } from "../services/functionRefs.js";
import { seedQ } from "./helpers/seedQ.js";
const effectiveModules = async (ws: string) => new Map([...(await functionIndex(null, ws)).byTag].map(([id, uses]) => [id, new Map(uses.map((u) => [u.functionId, u.sourceTagId]))]));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const NATIVE = { origin: "http://localhost" };
// The native System actor has no personal space and may sit in several
// spaces, so a top-level note names its space (services/spaces.ts newNoteSpace).
async function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json: rawJson, ...rest } = init;
  const json = path === "/api/nodes" && rest.method === "POST" && rawJson && typeof rawJson === "object"
    && !("space_id" in rawJson)
    ? { ...rawJson, space_id: (await q<{ id: string }>(
        `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [await getWorkspaceId()])).rows[0]!.id }
    : rawJson;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

describe.skipIf(!isTestDb)("tag merge (P2)", () => {
  const stamp = Date.now();
  let fixtures = 0;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    await getWorkspaceId();
  });

  // #source (with a source-only field) and #target (with a defaulted select),
  // n1 carrying #source and n2 carrying both. Fresh per test: a merge consumes it.
  const mergeFixture = async () => {
    const tag = `${stamp}x${++fixtures}`;
    const sourceId = ((await (await req("/api/tags/import", { method: "POST", json: {
      name: `mergeSrc${tag}`, fields: [{ name: "src_only", type: "text" }],
    } })).json()) as { id: string }).id;
    const targetId = ((await (await req("/api/tags/import", { method: "POST", json: {
      name: `mergeTgt${tag}`, fields: [{ name: "phase", type: "select", options: ["new", "old"], default: "new" }],
    } })).json()) as { id: string }).id;

    const n1 = ((await (await req("/api/nodes", { method: "POST", json: { title: `merge n1 ${tag}`, markdown: "x" } })).json()) as { id: string }).id;
    const n2 = ((await (await req("/api/nodes", { method: "POST", json: { title: `merge n2 ${tag}`, markdown: "x" } })).json()) as { id: string }).id;
    await req(`/api/nodes/${n1}/tags/${sourceId}`, { method: "PUT", json: {} });
    await req(`/api/nodes/${n1}/attributes/src_only`, { method: "PUT", json: { value: "keep me" } });
    await req(`/api/nodes/${n2}/tags/${sourceId}`, { method: "PUT", json: {} });
    await req(`/api/nodes/${n2}/tags/${targetId}`, { method: "PUT", json: {} });
    return { sourceId, targetId, n1, n2 };
  };

  it("merge-preview counts movers vs already-in-target and names source-only fields", async () => {
    const { sourceId, targetId } = await mergeFixture();
    const res = await req(`/api/tags/${sourceId}/merge-preview?target=${targetId}`);
    expect(res.status).toBe(200);
    const p = (await res.json()) as { members_gaining_target: number; already_in_target: number; fields_only_in_source: string[]; reversible: boolean };
    expect(p.members_gaining_target).toBe(1); // n1
    expect(p.already_in_target).toBe(1);      // n2
    expect(p.fields_only_in_source).toContain("src_only");
    expect(p.reversible).toBe(true);
  });

  it("merge applies target's full contract to movers and soft-deletes source", async () => {
    const { sourceId, targetId, n1 } = await mergeFixture();
    const res = await req(`/api/tags/${sourceId}/merge`, { method: "POST", json: { target_id: targetId } });
    expect(res.status).toBe(200);
    expect((await res.json()).members_gained_target).toBe(1);

    // n1 carries #target now, with target's default seeded; src_only value survives
    const boot = (await (await req("/api/bootstrap?bodies=none")).json()) as { nodes: Array<{ id: string; class_tag_ids?: string[]; attrs?: Record<string, string> }>; tags: Array<{ id: string }> };
    const node1 = boot.nodes.find((n) => n.id === n1)!;
    expect(node1.class_tag_ids).toContain(targetId);
    expect(node1.attrs?.phase).toBe("new");       // default seeded via the full apply path
    expect(node1.attrs?.src_only).toBe("keep me"); // orphaned value stays as plain property
    // source gone from the live tag list
    expect(boot.tags.some((t) => t.id === sourceId)).toBe(false);

    // provenance: the TAG_APPLIED + seeded ATTRIBUTE_SET chain to the TAG_MERGED root
    const root = await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE event_type = 'TAG_MERGED' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`,
      [sourceId],
    );
    const cascade = await (await req(`/api/events/${root.rows[0]!.id}/cascade-preview`)).json() as { count: number; events: Array<{ event_type: string }> };
    expect(cascade.count).toBeGreaterThanOrEqual(2); // TAG_APPLIED + ATTRIBUTE_SET (default)
    expect(cascade.events.map((e) => e.event_type)).toContain("TAG_APPLIED");
  });

  it("a trashed member of #source gets #target too, so it has it once restored", async () => {
    const { sourceId, targetId, n1 } = await mergeFixture();
    expect((await req(`/api/nodes/${n1}`, { method: "DELETE" })).status).toBeLessThan(300);
    expect((await req(`/api/tags/${sourceId}/merge`, { method: "POST", json: { target_id: targetId } })).status).toBe(200);
    const linked = await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [n1, targetId]);
    expect(linked.rowCount).toBe(1);
    expect((await req(`/api/nodes/${n1}/undelete`, { method: "POST", json: {} })).status).toBeLessThan(300);
    const boot = (await (await req("/api/bootstrap?bodies=none")).json()) as { nodes: Array<{ id: string; class_tag_ids?: string[] }> };
    expect(boot.nodes.find((n) => n.id === n1)!.class_tag_ids).toContain(targetId);
  });

  it("Trash undelete restores #source ONLY — target additions remain (partial, by design)", async () => {
    const { sourceId, targetId, n1 } = await mergeFixture();
    expect((await req(`/api/tags/${sourceId}/merge`, { method: "POST", json: { target_id: targetId } })).status).toBe(200);
    expect((await req(`/api/nodes/${sourceId}/undelete`, { method: "POST", json: {} })).status).toBeLessThan(300);
    const boot = (await (await req("/api/bootstrap?bodies=none")).json()) as { nodes: Array<{ id: string; class_tag_ids?: string[] }>; tags: Array<{ id: string }> };
    expect(boot.tags.some((t) => t.id === sourceId)).toBe(true);
    const node1 = boot.nodes.find((n) => n.id === n1)!;
    expect(node1.class_tag_ids).toContain(sourceId); // membership came back
    // the target additions are NOT undone by a node undelete — full undo is
    // the TAG_MERGED cascade reject, pinned in the next test.
    expect(node1.class_tag_ids).toContain(targetId);
  });

  it("FULL undo: cascade-restoring the TAG_MERGED event removes target additions and revives #source", async () => {
    // self-contained trio — the suite's earlier merges left residue by design
    const s2 = Date.now();
    const src2 = ((await (await req("/api/tags/import", { method: "POST", json: { name: `undoSrc${s2}`, fields: [] } })).json()) as { id: string }).id;
    const tgt2 = ((await (await req("/api/tags/import", { method: "POST", json: { name: `undoTgt${s2}`, fields: [{ name: "phase2", type: "text", default: "fresh" }] } })).json()) as { id: string }).id;
    const node = ((await (await req("/api/nodes", { method: "POST", json: { title: `undo node ${s2}`, markdown: "x" } })).json()) as { id: string }).id;
    await req(`/api/nodes/${node}/tags/${src2}`, { method: "PUT", json: {} });

    const merged = await (await req(`/api/tags/${src2}/merge`, { method: "POST", json: { target_id: tgt2 } })).json() as { merge_event_id: string };
    expect(merged.merge_event_id).toBeTruthy();
    // post-merge state: node carries tgt2 + seeded default; src2 soft-deleted
    let boot = (await (await req("/api/bootstrap?bodies=none")).json()) as { nodes: Array<{ id: string; class_tag_ids?: string[]; attrs?: Record<string, string> }>; tags: Array<{ id: string }> };
    let n = boot.nodes.find((x) => x.id === node)!;
    expect(n.class_tag_ids).toContain(tgt2);
    expect(n.attrs?.phase2).toBe("fresh");

    const res = await req(`/api/events/${merged.merge_event_id}/restore`, { method: "POST", json: { cascade: true } });
    expect(res.status).toBeLessThan(300);

    boot = (await (await req("/api/bootstrap?bodies=none")).json()) as typeof boot;
    expect(boot.tags.some((t) => t.id === src2)).toBe(true);   // source revived
    n = boot.nodes.find((x) => x.id === node)!;
    expect(n.class_tag_ids).toContain(src2);                    // source membership intact
    expect(n.class_tag_ids).not.toContain(tgt2);                // target ADDITION undone
    expect(n.attrs?.phase2).toBeUndefined();                    // seeded default undone
  });

  it("merge reparents #source's child tags onto #target, and the cascade restore reverts them (M8)", async () => {
    const s = Date.now();
    const WS = await getWorkspaceId();
    const src = ((await (await req("/api/tags/import", { method: "POST", json: { name: `m8Src${s}`, fields: [] } })).json()) as { id: string }).id;
    const tgt = ((await (await req("/api/tags/import", { method: "POST", json: { name: `m8Tgt${s}`, fields: [] } })).json()) as { id: string }).id;
    // A child tag nested under #source (parent_id = src).
    const child = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, tag_color)
       VALUES ($1,'manual','class_tag',$2,$3,'',$4,'#888888') RETURNING id`,
      [WS, `m8Child${s}`, `m8-child-${s}`, src],
    )).rows[0]!.id;

    const merged = await (await req(`/api/tags/${src}/merge`, { method: "POST", json: { target_id: tgt } })).json() as { merge_event_id: string };
    expect(merged.merge_event_id).toBeTruthy();

    // Child reparented onto #target (not left dangling on the deleted source);
    // #source soft-deleted.
    const afterMerge = (await q<{ parent_id: string | null; src_deleted: boolean }>(
      `SELECT c.parent_id, (s.deleted_at IS NOT NULL) AS src_deleted
         FROM content_nodes c, content_nodes s WHERE c.id=$1 AND s.id=$2`,
      [child, src],
    )).rows[0]!;
    expect(afterMerge.parent_id, "child reparented onto target").toBe(tgt);
    expect(afterMerge.src_deleted).toBe(true);

    // Cascade-restoring the merge reverts the reparent and revives #source.
    const res = await req(`/api/events/${merged.merge_event_id}/restore`, { method: "POST", json: { cascade: true } });
    expect(res.status).toBeLessThan(300);
    const afterRestore = (await q<{ parent_id: string | null; src_deleted: boolean }>(
      `SELECT c.parent_id, (s.deleted_at IS NOT NULL) AS src_deleted
         FROM content_nodes c, content_nodes s WHERE c.id=$1 AND s.id=$2`,
      [child, src],
    )).rows[0]!;
    expect(afterRestore.parent_id, "reparent reverted to source").toBe(src);
    expect(afterRestore.src_deleted, "source revived").toBe(false);
  });

  it("self-merge and unknown targets are clean 400/404s", async () => {
    const { targetId } = await mergeFixture();
    expect((await req(`/api/tags/${targetId}/merge`, { method: "POST", json: { target_id: targetId } })).status).toBe(400);
    expect((await req(`/api/tags/${targetId}/merge-preview?target=${targetId}`)).status).toBe(400);
    expect((await req(`/api/tags/${targetId}/merge`, { method: "POST", json: { target_id: "00000000-0000-4000-8000-0000000000aa" } })).status).toBe(404);
  });
});

describe.skipIf(!isTestDb)("tag merge guards", () => {
  const stamp = Date.now();
  const mkTag = async (name: string, parentId?: string): Promise<string> => {
    const id = ((await (await req("/api/tags/import", { method: "POST", json: { name } })).json()) as { id: string }).id;
    if (parentId) await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [id, parentId]);
    return id;
  };

  it("refuses to merge a tag into its own sub-tag (would loop parent_id)", async () => {
    const parent = await mkTag(`guardParent${stamp}`);
    const child = await mkTag(`guardChild${stamp}`, parent);
    const res = await req(`/api/tags/${parent}/merge`, { method: "POST", json: { target_id: child } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("merge_into_sub_tag");
    // The preview refuses it too, with the same code, instead of passing and failing at the button.
    const preview = await req(`/api/tags/${parent}/merge-preview?target=${child}`);
    expect(preview.status).toBe(400);
    expect(((await preview.json()) as { error: string }).error).toBe("merge_into_sub_tag");
    const row = await q<{ deleted_at: string | null; parent_id: string | null }>(
      `SELECT deleted_at, parent_id FROM content_nodes WHERE id = $1`, [child]);
    expect(row.rows[0]!.deleted_at).toBeNull();
    expect(row.rows[0]!.parent_id).toBe(parent);
  });

  it("refuses a module tag as the target, in the preview and the merge (module-tag-target)", async () => {
    const source = await mkTag(`guardModSrc${stamp}`);
    const moduleTag = await mkTag(`guardModTgt${stamp}`);
    await seedQ(`UPDATE content_nodes SET tag_schema = COALESCE(tag_schema, '{}'::jsonb) || '{"module":"review"}'::jsonb WHERE id = $1`, [moduleTag]);
    for (const res of [
      await req(`/api/tags/${source}/merge-preview?target=${moduleTag}`),
      await req(`/api/tags/${source}/merge`, { method: "POST", json: { target_id: moduleTag } }),
    ]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("merge_into_module_tag");
    }
    expect((await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [source])).rows[0]!.deleted_at).toBeNull();
  });

  it("the preview counts the functions and views of the source that the merge does not carry over (merge-preview-functions-views)", async () => {
    const source = await mkTag(`guardHeldSrc${stamp}`);
    const target = await mkTag(`guardHeldTgt${stamp}`);
    const ws = (await q<{ workspace_id: string }>(`SELECT workspace_id::text FROM content_nodes WHERE id = $1`, [source])).rows[0]!.workspace_id;
    const hold = (functionId: string, instance: string) => seedQ(
      `INSERT INTO function_refs (workspace_id, function_id, instance, holder_node_id) VALUES ($1, $2, $3, $4)`, [ws, functionId, instance, source]);
    await hold("review", "");
    await hold("table", "v1");
    await hold("kanban", "v2");
    const p = (await (await req(`/api/tags/${source}/merge-preview?target=${target}`)).json()) as { functions_not_carried: number; views_not_carried: number };
    expect(p).toMatchObject({ functions_not_carried: 1, views_not_carried: 2 });
    const none = (await (await req(`/api/tags/${target}/merge-preview?target=${source}`)).json()) as { functions_not_carried: number; views_not_carried: number };
    expect(none).toMatchObject({ functions_not_carried: 0, views_not_carried: 0 });
  });

  it("answers 409 (not 500) when both tags have a sub-tag of the same name, and changes nothing", async () => {
    const a = await mkTag(`guardA${stamp}`);
    const b = await mkTag(`guardB${stamp}`);
    await mkTag(`dup${stamp}`, a);
    // Same name under b: created under a different parent, so the unique index allows it.
    const dupB = await mkTag(`dupB${stamp}`, b);
    await seedQ(`UPDATE content_nodes SET title = $2 WHERE id = $1`, [dupB, `dup${stamp}`]);
    const res = await req(`/api/tags/${a}/merge`, { method: "POST", json: { target_id: b } });
    expect(res.status).toBe(409);
    const src = await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [a]);
    expect(src.rows[0]!.deleted_at).toBeNull();
  });

  it("moves sub-tags whose names differ only in case: the name rule is exact (T6)", async () => {
    const a = await mkTag(`caseA${stamp}`);
    const b = await mkTag(`caseB${stamp}`);
    const upper = await mkTag(`Folded${stamp}`, a);
    await mkTag(`folded${stamp}`, b);
    const res = await req(`/api/tags/${a}/merge`, { method: "POST", json: { target_id: b } });
    expect(res.status).toBe(200);
    const moved = await q<{ parent_id: string | null }>(`SELECT parent_id FROM content_nodes WHERE id = $1`, [upper]);
    expect(moved.rows[0]!.parent_id).toBe(b);
  });
});

// D57: membership and inherited fields/modules follow `extends` as well as
// parent_id, so a merge re-points the tags that extend #source at #target.
describe.skipIf(!isTestDb)("tag merge re-points extends (D57)", () => {
  const mkTag = async (name: string, fields: unknown[] = []): Promise<string> =>
    ((await (await req("/api/tags/import", { method: "POST", json: { name, fields } })).json()) as { id: string }).id;
  // A user tag extending a user tag is legacy: PUT /extends refuses a new one
  // (D105), so these links are stored as data from before #360 would hold them.
  const setExtends = async (tagId: string, ids: string[]) => {
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('extends', $2::jsonb) WHERE id = $1`, [tagId, JSON.stringify(ids)]);
  };
  const extendsOf = async (tagId: string): Promise<unknown> =>
    (await q<{ e: unknown }>(`SELECT tag_schema->'extends' AS e FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.e;

  it("#novel extends #book; merging #book into #livre: #novel's notes count under #livre and it inherits #livre", async () => {
    const s = Date.now();
    const WS = await getWorkspaceId();
    const book = await mkTag(`book${s}`, [{ name: "author", type: "text" }]);
    const livre = await mkTag(`livre${s}`, [{ name: "auteur", type: "text" }]);
    const novel = await mkTag(`novel${s}`);
    await setExtends(novel, [book]);
    expect((await req(`/api/tags/${livre}/modules`, { method: "PATCH", json: { skills: true } })).status).toBe(200);
    // Where #livre's skills settings come from is chosen when the function is added: the workspace's
    // skills module tag if some other test file has imported one into the shared workspace, else #livre
    // itself. The merge must not change that, so compare against what was stored, not a fixed tag.
    const reviewSourceBefore = (await effectiveModules(WS)).get(livre)?.get("skills");
    expect(reviewSourceBefore).toBeTruthy();
    const note = ((await (await req("/api/nodes", { method: "POST", json: { title: `novel note ${s}`, markdown: "x" } })).json()) as { id: string }).id;
    await req(`/api/nodes/${note}/tags/${novel}`, { method: "PUT", json: {} });

    const preview = await (await req(`/api/tags/${book}/merge-preview?target=${livre}`)).json() as { extenders_repointed: number };
    expect(preview.extenders_repointed).toBe(1);

    const merged = await (await req(`/api/tags/${book}/merge`, { method: "POST", json: { target_id: livre } })).json() as { merge_event_id: string };
    expect(merged.merge_event_id).toBeTruthy();
    expect(await extendsOf(novel)).toEqual([livre]);
    expect(await memberTagIds(WS, livre)).toContain(novel);
    const query = await (await req("/api/query", { method: "POST", json: { tags: [`livre${s}`], limit: 50 } })).json() as { rows: Array<{ id: string }> };
    expect(query.rows.map((n) => n.id)).toContain(note);
    // #novel still inherits #livre's fields through extends; its functions no longer pass down (decision 9),
    // and #livre keeps the skills function it was given, with the same source.
    expect((await effectiveModules(WS)).get(novel)?.get("skills")).toBeUndefined();
    expect((await effectiveModules(WS)).get(livre)?.get("skills")).toBe(reviewSourceBefore);

    // The re-point is a TAG_SCHEMA_UPDATED chained to the merge root.
    const chained = await q<{ prev: unknown }>(
      `SELECT tx_meta->'prev_field_values'->'extends' AS prev FROM domain_events
        WHERE event_type = 'TAG_SCHEMA_UPDATED' AND target_id = $1 AND triggered_by_event_id = $2::bigint`,
      [novel, merged.merge_event_id],
    );
    expect(chained.rows.map((r) => r.prev)).toEqual([[book]]);
  });

  it("dedupes an extender of both tags, drops #target extending itself, and the cascade restore puts both back", async () => {
    const s = Date.now();
    const src = await mkTag(`d57Src${s}`);
    const tgt = await mkTag(`d57Tgt${s}`);
    const both = await mkTag(`d57Both${s}`);
    await setExtends(both, [src, tgt]);
    await setExtends(tgt, [src]);

    const preview = await (await req(`/api/tags/${src}/merge-preview?target=${tgt}`)).json() as { extenders_repointed: number };
    expect(preview.extenders_repointed).toBe(2);
    const merged = await (await req(`/api/tags/${src}/merge`, { method: "POST", json: { target_id: tgt } })).json() as { merge_event_id: string };
    expect(await extendsOf(both)).toEqual([tgt]);
    expect(await extendsOf(tgt)).toEqual([]);

    const res = await req(`/api/events/${merged.merge_event_id}/restore`, { method: "POST", json: { cascade: true } });
    expect(res.status).toBeLessThan(300);
    expect(await extendsOf(both)).toEqual([src, tgt]);
    expect(await extendsOf(tgt)).toEqual([src]);
    expect((await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [src])).rows[0]!.deleted_at).toBeNull();
  });

  it("refuses (409) a merge whose re-point would make tags extend each other, and changes nothing", async () => {
    const s = Date.now();
    const src = await mkTag(`cycSrc${s}`);
    const tgt = await mkTag(`cycTgt${s}`);
    const mid = await mkTag(`cycMid${s}`);
    await setExtends(mid, [src]);
    await setExtends(tgt, [mid]); // after the merge #mid would extend #tgt, which extends #mid
    expect((await req(`/api/tags/${src}/merge-preview?target=${tgt}`)).status).toBe(409);
    const res = await req(`/api/tags/${src}/merge`, { method: "POST", json: { target_id: tgt } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("extends_cycle");
    expect(await extendsOf(mid)).toEqual([src]);
    expect((await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [src])).rows[0]!.deleted_at).toBeNull();
  });
});
