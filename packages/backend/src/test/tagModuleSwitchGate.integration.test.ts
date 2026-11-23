// D72: module switches (`behaviour.modules`, the legacy per-tag switch) change
// only through PATCH /api/tags/:id/modules. The rule lives in the schema
// writer (tagWrites keepModuleSwitches), so the schema PATCH, the owner's pack
// import and an approved agent proposal store the same behaviour for the same
// input; a pack's switches become extends of the module's tag instead
// (tagPacks.packModuleSwitches), and the rest are reported.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
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
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

type Stored = { id: string; behaviour: Record<string, unknown>; extends: string[] | null };
async function stored(name: string): Promise<Stored | null> {
  return (await q<Stored>(
    `SELECT id, tag_schema->'behaviour' AS behaviour, tag_schema->'extends' AS extends FROM content_nodes
      WHERE title = $1 AND node_type = 'class_tag' AND deleted_at IS NULL`, [name])).rows[0] ?? null;
}

async function modulesOf(tagId: string): Promise<string[]> {
  return [...((await effectiveModules(await getWorkspaceId())).get(tagId)?.keys() ?? [])];
}

/** The live module tag of `module`, imported if the workspace has none. */
async function moduleTag(module: string): Promise<string> {
  const response = await req("/api/workspace/modules", { method: "PATCH", json: { module, imported: true } });
  expect(response.status).toBe(200);
  // The endpoint names this workspace's module tag; a lookup by `module`
  // alone would find other workspaces' module tags in the shared DB.
  const { module_tag_id } = (await response.json()) as { module_tag_id?: string };
  expect(module_tag_id).toBeTruthy();
  return module_tag_id!;
}

async function propose(token: string, args: Record<string, unknown>): Promise<void> {
  const response = await req("/api/mcp/tools/proposeTagPack", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, json: { args },
  });
  expect(response.status).toBeLessThan(300);
  const approvals = (await (await req("/api/inbox/approvals")).json()) as { approvals: Array<{ id: string; effect_kind: string; payload: { pack?: { name?: string } } }> };
  const held = approvals.approvals.find((a) => a.effect_kind === "tag_pack" && a.payload.pack?.name === args.name)!;
  expect((await req(`/api/inbox/approvals/${held.id}/approve`, { method: "POST", json: {} })).status).toBeLessThan(300);
  // The approve route drains the outbox asynchronously.
  for (let i = 0; i < 40 && !(await stored(String(args.name))); i++) await new Promise((res) => setTimeout(res, 100));
}

async function importPack(pack: Record<string, unknown>) {
  const response = await req("/api/tags/import", { method: "POST", json: { _format: "onden.tagpack/v1", ...pack } });
  expect(response.status).toBe(201);
  return await response.json() as { id: string; module_switches: Array<{ module: string; result: string }> };
}

describe.skipIf(!isTestDb)("module switches only through the modules endpoint (D72)", () => {
  const stamp = Date.now();
  let token = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    await getWorkspaceId();
    // A real token (app.ts refuses a bearer that does not resolve): the setup must succeed, not send "Bearer undefined".
    const made = await req("/api/actors", { method: "POST", json: { name: `d72 bot ${stamp}`, type: "agent" } });
    expect(made.status, await made.clone().text()).toBeLessThan(300);
    const actor = await made.json() as { id: string };
    const minted = await req(`/api/actors/${actor.id}/tokens`, { method: "POST", json: { access: "write" } });
    expect(minted.status, await minted.clone().text()).toBeLessThan(300);
    token = ((await minted.json()) as { token: string }).token;
    expect(token).toMatch(/^ondt_/);
  });

  it("bug 1: an imported pack's skills switch becomes an extends of the skills module tag, not a stored switch", async () => {
    const skills = await moduleTag("skills");
    const body = await importPack({ name: `flash${stamp}`, behaviour: { modules: { skills: { enabled: true } } } });
    expect(body.module_switches).toEqual([{ module: "skills", result: "extends" }]);
    const tag = (await stored(`flash${stamp}`))!;
    expect(tag.behaviour).toEqual({});
    expect(tag.extends).toEqual([skills]);
    // #flash gets skills from the module tag, the way the tag page adds it.
    expect((await effectiveModules(await getWorkspaceId())).get(tag.id)?.get("skills")).toBe(skills);
  });

  it("a switch whose module has no tag here is dropped and reported", async () => {
    // Keep the workspace without a live skills module tag for this case.
    const existing = (await q<{ id: string }>(
      "SELECT id FROM content_nodes WHERE workspace_id = $1 AND node_type='class_tag' AND deleted_at IS NULL AND tag_schema->>'module'='skills'",
      [await getWorkspaceId()])).rows.map((r) => r.id);
    await seedQ("UPDATE content_nodes SET deleted_at = now() WHERE id = ANY($1::uuid[])", [existing]);
    try {
      const body = await importPack({ name: `skillpack${stamp}`, behaviour: { modules: { skills: { enabled: true } } } });
      expect(body.module_switches).toEqual([{ module: "skills", result: "no_module_tag" }]);
      const tag = (await stored(`skillpack${stamp}`))!;
      expect(tag.behaviour).toEqual({});
      expect(tag.extends).toBeNull();
      expect(await modulesOf(tag.id)).toEqual([]);
    } finally {
      await seedQ("UPDATE content_nodes SET deleted_at = NULL WHERE id = ANY($1::uuid[])", [existing]);
    }
  });

  it("bug 2: an unknown module id is not stored; the import reports it", async () => {
    const body = await importPack({ name: `nope${stamp}`, behaviour: { review: { new_per_day: 5 }, modules: { nope: { enabled: true } } } });
    expect(body.module_switches).toEqual([{ module: "nope", result: "unknown_module" }]);
    const tag = (await stored(`nope${stamp}`))!;
    expect(tag.behaviour).toEqual({ review: { new_per_day: 5 } });
    const event = await q<{ payload: { module_switches?: unknown } }>(
      "SELECT payload FROM domain_events WHERE event_type='TAG_IMPORTED' AND target_id=$1", [tag.id]);
    expect(event.rows[0]!.payload.module_switches).toEqual([{ module: "nope", result: "unknown_module" }]);
  });

  it("import, an approved proposal and the schema PATCH store the same behaviour for the same input", async () => {
    const skills = await moduleTag("skills");
    const behaviour = { skills: { new_per_day: 7 }, modules: { skills: { enabled: true }, nope: { enabled: true }, review: { enabled: false } } };

    await importPack({ name: `same-import${stamp}`, behaviour });
    await propose(token, { name: `same-proposal${stamp}`, behaviour });
    const created = await req("/api/tags/resolve-path", { method: "POST", json: { path: `same-patch${stamp}` } });
    expect(created.status).toBe(200);
    const patchId = ((await created.json()) as { leaf_id: string }).leaf_id;
    const patched = await req(`/api/tags/${patchId}/schema`, { method: "PATCH", json: { behaviour } });
    expect(patched.status).toBe(200);

    const imported = (await stored(`same-import${stamp}`))!;
    const proposed = (await stored(`same-proposal${stamp}`))!;
    const patchedRow = (await stored(`same-patch${stamp}`))!;
    for (const tag of [imported, proposed, patchedRow]) expect(tag.behaviour).toEqual({ skills: { new_per_day: 7 } });
    // Both pack paths turn the switch into the same extends; the PATCH, which
    // edits automation, never adds one.
    expect(imported.extends).toEqual([skills]);
    expect(proposed.extends).toEqual([skills]);
    expect(patchedRow.extends).toBeNull();
    const event = await q<{ payload: { module_switches?: unknown; via_approval?: boolean } }>(
      "SELECT payload FROM domain_events WHERE event_type='TAG_IMPORTED' AND target_id=$1", [proposed.id]);
    const imports = await q<{ payload: { module_switches?: unknown } }>(
      "SELECT payload FROM domain_events WHERE event_type='TAG_IMPORTED' AND target_id=$1", [imported.id]);
    expect(imports.rows[0]!.payload.module_switches).toEqual((event.rows[0]!.payload as { module_switches?: unknown }).module_switches);
    expect(event.rows[0]!.payload).toMatchObject({
      via_approval: true,
      module_switches: [
        { module: "nope", result: "unknown_module" },
        { module: "review", result: "unknown_module" }, // review has no tag function since migration 195
        { module: "skills", result: "extends" },
      ],
    });
  });

  it("the schema PATCH keeps the stored switches; only the modules endpoint changes them", async () => {
    const created = await req("/api/tags/resolve-path", { method: "POST", json: { path: `switch${stamp}` } });
    const tagId = ((await created.json()) as { leaf_id: string }).leaf_id;
    expect((await req(`/api/tags/${tagId}/modules`, { method: "PATCH", json: { skills: true } })).status).toBe(200);
    const patched = await req(`/api/tags/${tagId}/schema`, { method: "PATCH", json: { behaviour: { modules: { review: { enabled: true } } } } });
    expect(patched.status).toBe(200);
    // The schema PATCH's modules key means nothing any more: the only switch is the function reference the modules endpoint wrote.
    expect((await stored(`switch${stamp}`))!.behaviour).toEqual({});
    expect((await q<{ function_id: string }>("SELECT function_id FROM function_refs WHERE holder_node_id=$1", [tagId])).rows.map((r) => r.function_id)).toEqual(["skills"]);
    expect((await req(`/api/tags/${tagId}/modules`, { method: "PATCH", json: { nope: true } })).status).toBe(400);
  });

  it("export carries the tag functions a tag gets by extending, and a re-import extends the same module tag", async () => {
    const skills = await moduleTag("skills");
    const created = await req("/api/tags/resolve-path", { method: "POST", json: { path: `course${stamp}` } });
    const courseId = ((await created.json()) as { leaf_id: string }).leaf_id;
    expect((await req(`/api/tags/${courseId}/extends`, { method: "PUT", json: { extends: [skills] } })).status).toBe(200);
    const pack = await (await req(`/api/tags/${courseId}/export`)).json() as { modules?: string[]; behaviour: Record<string, unknown> };
    expect(pack.modules).toEqual(["skills"]);
    expect(pack.behaviour).toEqual({ modules: { skills: { enabled: true } } });
    await importPack({ ...pack, name: `course-copy${stamp}` });
    expect((await stored(`course-copy${stamp}`))!.extends).toEqual([skills]);
  });
});
