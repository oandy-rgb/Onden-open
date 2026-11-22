import { sql } from "kysely";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { assertAuthority } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { mutate } from "../spine/mutate.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { buildTagSchema, changeTagSchema, insertTagRow } from "./tagWrites.js";
import { normalizeFieldIdentifiers } from "./tagPacks.js";

import { cutToUnits, derivedIdName } from "@onden/markdown";
import { newIdFor } from "./derivedIds.js";
import { isShippedModule } from "./moduleCatalog.js";
import { StatusError } from "../statusError.js";
import { liveNodeSql, liveTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";
/** A module's tag (ModuleDefinition.library.moduleTag). `name` is the default
 *  when the client sends none; `legacyNames` are names the module's tag went
 *  by before it was marked (a top-level tag with one is adopted); `template`
 *  is what a newly created module tag starts with. `unusedOnly` (the view
 *  modules) adopts a same-named tag only while it is unused — no notes, child
 *  tags, fields or views — and otherwise creates the module tag as
 *  `unusedOnly.otherwise`, so the user's own #月曆 keeps its notes. */
export type ModuleTagSpec = {
  name: string;
  legacyNames?: string[];
  unusedOnly?: { otherwise: string };
  template?: { fields?: unknown[]; behaviour?: Record<string, unknown>; description?: string; version?: string; color?: string };
};

// The module library (docs/architecture/module-library.md): the built-in
// functions are like a standard library — every shipped module is on in every
// workspace unless the owner turned it off. A module that is off stays out of
// the interface and its background work pauses; its data is kept.
//
// Storage is what the owner decided, not what is available, so a module added
// in a later release is on without a migration:
//   workspaces.modules_off        ids the owner turned off (a list; default [])
//   workspaces.modules_confirmed  ids of confirm-once modules (below) the owner
//                                 agreed to use; NULL = not decided yet, filled
//                                 by backfillModuleImports at boot
// A confirm-once module (ModuleDefinition.library.confirmOnce: semantic search
// spends money, RSS reaches outside websites, the website publishes to the web)
// is on only after that one agreement; turning it off and on again does not ask
// again. workspaces.modules is the retired pre-2026-10-24 "imported" list; it is
// no longer read except to tell backfillModuleImports a workspace is old.

// Filled by registerModuleEffects from ModuleDefinition.library — the core
// never lists module ids.
const libraryModules = new Set<string>();
const confirmOnceModules = new Set<string>();
// View modules (table, calendar, board, gallery): a way of arranging notes that
// carries no data of its own, so there is nothing to turn on or off (2026-10-28).
const alwaysOnModules = new Set<string>();
const moduleTagSpecs = new Map<string, ModuleTagSpec>();
// A module that needs others (skills need ai): on only while they are on.
const moduleRequires = new Map<string, readonly string[]>();
// Durable work a module files when the owner turns it on (semantic search: index the notes already there).
const turnedOnHooks = new Map<string, (workspaceId: string) => Promise<void>>();

export function registerLibraryModule(
  id: string, moduleTag?: ModuleTagSpec,
  { confirmOnce = false, alwaysOn = false, requires = [] as readonly string[], whenTurnedOn }:
    { confirmOnce?: boolean; alwaysOn?: boolean; requires?: readonly string[]; whenTurnedOn?: (workspaceId: string) => Promise<void> } = {},
): void {
  libraryModules.add(id);
  if (whenTurnedOn) turnedOnHooks.set(id, whenTurnedOn);
  if (requires.length) moduleRequires.set(id, requires);
  if (alwaysOn) alwaysOnModules.add(id);
  if (confirmOnce) confirmOnceModules.add(id);
  if (moduleTag) moduleTagSpecs.set(id, moduleTag);
}

/** Whether the owner must agree once before this module is on. */
export function isConfirmOnceModule(id: string): boolean {
  return confirmOnceModules.has(id);
}

/** The owner's decisions about the built-in functions (see above). */
export type ModuleState = { off: string[]; confirmed: string[] };

export function moduleStateOf(row: { modules_off?: unknown; modules_confirmed?: unknown } | undefined): ModuleState {
  return { off: asModuleList(row?.modules_off) ?? [], confirmed: asModuleList(row?.modules_confirmed) ?? [] };
}

/** Whether one module is on: not turned off and, when it needs the owner's
 *  one-time agreement, agreed to. The single rule every reader goes through. */
function moduleOn(state: ModuleState, id: string): boolean {
  if (alwaysOnModules.has(id)) return true;
  return libraryModules.has(id) && !state.off.includes(id) && (!confirmOnceModules.has(id) || state.confirmed.includes(id))
    && (moduleRequires.get(id) ?? []).every((required) => moduleOn(state, required));
}

/** The modules that are on, in registration order. */
export function modulesOn(state: ModuleState): string[] {
  return libraryModuleIds().filter((id) => moduleOn(state, id));
}

/** The confirm-once modules still waiting for the owner's agreement. */
export function modulesToConfirm(state: ModuleState): string[] {
  return libraryModuleIds().filter((id) => confirmOnceModules.has(id) && !state.confirmed.includes(id));
}

/** A workspace row as clients get it (bootstrap, sync delta, settings): the
 *  stored decisions become `modules` (what is on) and `modules_to_confirm`. */
export function workspaceWireRow<T extends { modules_off?: unknown; modules_confirmed?: unknown }>(row: T):
  Omit<T, "modules_off" | "modules_confirmed"> & { modules: string[]; modules_to_confirm: string[] } {
  const { modules_off, modules_confirmed, ...rest } = row;
  const state = moduleStateOf({ modules_off, modules_confirmed });
  return { ...rest, modules: modulesOn(state), modules_to_confirm: modulesToConfirm(state) };
}

/** The modules the library ships, in registration order. */
export function libraryModuleIds(): string[] {
  return [...libraryModules];
}

export function asModuleList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

/** Whether `id` is on, given the list `workspaceModules` answers (NULL = all). */
/** Whether the workspace has this module on (reads its state). The one
 *  question a module's gates, and a core path that waits on a module, ask. */
export async function workspaceHasModule(workspaceId: string, id: string): Promise<boolean> {
  return isModuleImported(await workspaceModules(workspaceId), id);
}

/** Whether a module's own functions are in use in the workspace: a built-in module (shipped, no library
 *  entry, no switch: capture) always; a library module while it is on; an id this build does not ship
 *  (a removed module's leftovers) never. The rule behind "a module's tag is kept while its module is on"
 *  (reservedTags.assertTagDefinitionChange). */
export async function workspaceUsesModule(workspaceId: string, id: string): Promise<boolean> {
  if (!isShippedModule(id)) return false;
  return !libraryModules.has(id) || workspaceHasModule(workspaceId, id);
}

export function isModuleImported(modules: string[] | null | undefined, id: string): boolean {
  return modules == null || modules.includes(id);
}

/** The modules that are on in a workspace. */
export async function workspaceModules(workspaceId: string): Promise<string[]> {
  return modulesOn(await readModuleState(workspaceId));
}

/** Whether the owner has left module `id` on, asking the workspace record
 *  alone (no registry, so it answers the same before the modules are mounted).
 *  Right for a module that needs no first agreement (not `confirmOnce`): the
 *  tasks module's gates use it. */
export async function moduleLeftOn(workspaceId: string, id: string): Promise<boolean> {
  return !(await readModuleState(workspaceId)).off.includes(id);
}

async function readModuleState(workspaceId: string, { lock = false } = {}): Promise<ModuleState> {
  const r = await q<{ modules_off: unknown; modules_confirmed: unknown }>(
    `SELECT modules_off, modules_confirmed FROM workspaces WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [workspaceId],
  );
  return moduleStateOf(r.rows[0]);
}

/** A library module's tool was called in a workspace where it is off. */
export class ModuleNotImportedError extends Error {
  readonly code = "module_not_imported";
  constructor(public module: string) { super(`module_not_imported: ${module}`); }
}

export class ModuleLibraryError extends StatusError {
  constructor(status: 400 | 404 = 400, message = "unknown module") { super(status, message); }
}

/** Turn one module on or off (the wire and event names still say imported /
 *  removed). Deciding what a workspace can do is an owner decision, so it
 *  takes the principal admin gate (as tag functions do). Turning off keeps the
 *  module's data, its module tag included; turning on again brings it back.
 *  Turning on a confirm-once module is the owner's agreement and is recorded,
 *  so it never asks again. Turning on a module that gives tags an ability
 *  (review, skills) also makes sure its module tag exists — even when the
 *  module was already on — named `tagName` (the client sends it in the
 *  interface language, e.g. 複習) or the module's default name. */
export function setModuleImported(input: {
  actor: ActorCtx;
  workspaceId: string;
  module: string;
  imported: boolean;
  tagName?: string;
}): Promise<{ modules: string[]; modules_to_confirm: string[]; module_tag_id?: string }> {
  const { workspaceId, module, imported } = input;
  if (!libraryModules.has(module)) return Promise.reject(new ModuleLibraryError(400, `unknown module: ${module}`));
  if (!imported && alwaysOnModules.has(module)) return Promise.reject(new ModuleLibraryError(400, `module cannot be turned off: ${module}`));
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    await assertAuthority(actor, { kind: "principal_admin" });
    const current = await readModuleState(workspaceId, { lock: true });
    const missing = imported ? (moduleRequires.get(module) ?? []).find((required) => !moduleOn(current, required)) : undefined;
    if (missing) throw new ModuleLibraryError(400, `module needs another module that is off: ${module} needs ${missing}`);
    const off = imported ? current.off.filter((id) => id !== module) : [...new Set([...current.off, module])];
    const confirmed = imported && confirmOnceModules.has(module) && !current.confirmed.includes(module)
      ? [...current.confirmed, module] : current.confirmed;
    const next: ModuleState = { off, confirmed };
    let state = current;
    if (off.length !== current.off.length || confirmed.length !== current.confirmed.length) {
      state = await mutate({
        actor, workspaceId, authority: { kind: "principal_admin" },
        event: {
          type: imported ? "MODULE_IMPORTED" : "MODULE_REMOVED",
          targetType: "workspace", targetId: workspaceId,
          payload: { module },
        },
        apply: async () => {
          await q(`UPDATE workspaces SET modules_off = $2::jsonb, modules_confirmed = $3::jsonb WHERE id = $1`,
            [workspaceId, JSON.stringify(next.off), JSON.stringify(next.confirmed)]);
          return next;
        },
      });
    }
    // Turned on (not merely asked again): the module files its start-up work in this same transaction.
    if (imported && state !== current) await turnedOnHooks.get(module)?.(workspaceId);
    const reply = { modules: modulesOn(state), modules_to_confirm: modulesToConfirm(state) };
    const spec = moduleTagSpecs.get(module);
    if (!imported || spec === undefined) return reply;
    const moduleTagId = await ensureModuleTag(actor, workspaceId, module, cleanTagName(input.tagName));
    return { ...reply, module_tag_id: moduleTagId };
  });
}

/** A usable top-level tag name: no leading #, single spaces, and no "/"
 *  (which would read as a tag path, a/b). */
function cleanTagName(name: string | undefined): string {
  return cutToUnits((name ?? "").trim().replace(/^#+/, "").replace(/\//g, "-").replace(/\s+/g, " ").trim(), 100).trimEnd();
}

/** The module's tag, read only: the live tag marked with this module, else
 *  an unmarked tag ensureModuleTag would adopt — a top-level tag named `name`,
 *  or a tag at any depth with one of the module's legacy names (those name
 *  the old tag itself, wherever it was put), case-insensitive. `lock` takes
 *  the row lock for an adoption in the caller's transaction. */
export async function findModuleTag(workspaceId: string, module: string, name?: string, { lock = false, trashed = false } = {}): Promise<
  { id: string; title: string; tag_schema: Record<string, unknown> | null; marked: boolean } | null
> {
  // `trashed`: the marked tag in the trash instead (reviveModuleTag), the one with the most live notes first; no adoption by name.
  const existing = await q<{ id: string; title: string; tag_schema: Record<string, unknown> | null }>(
    `SELECT id, title, tag_schema FROM content_nodes
      WHERE workspace_id = $1 AND ${trashed ? `${tagNodeSql()} AND deleted_at IS NOT NULL` : liveTagNodeSql()} AND tag_schema->>'module' = $2
      ORDER BY ${trashed ? `(SELECT count(*) FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id AND ${liveNodeSql("n")} WHERE nt.tag_id = content_nodes.id) DESC, ` : ""}created_at, id LIMIT 1`,
    [workspaceId, module],
  );
  if (existing.rows[0]) return { ...existing.rows[0], marked: true };
  if (trashed) return null;
  const legacy = (moduleTagSpecs.get(module)?.legacyNames ?? []).map((candidate) => candidate.toLowerCase());
  const names = [...(name ? [name.toLowerCase()] : []), ...legacy];
  if (!names.length) return null;
  const named = (await q<{ id: string; title: string; tag_schema: Record<string, unknown> | null }>(
    `SELECT id, title, tag_schema FROM content_nodes
      WHERE workspace_id = $1 AND ${liveTagNodeSql()}
        AND lower(title) = ANY($2::text[]) AND (parent_id IS NULL OR lower(title) = ANY($4::text[]))
        AND (tag_schema IS NULL OR tag_schema->>'module' IS NULL)
      ORDER BY (lower(title) = $3) DESC, (parent_id IS NULL) DESC, created_at LIMIT 1${lock ? " FOR UPDATE" : ""}`, [workspaceId, names, names[0], legacy],
  )).rows[0];
  return named ? { ...named, marked: false } : null;
}

/** Where the older captures of a deleted inbox are stranded (services/strandedInboxRepair.ts): a live tag of `module` and a trashed
 *  one in the same workspace, with the live top-level notes still on the trashed one and not on the live one. Read-only. */
type StrandedModuleTag = { workspaceId: string; trashedTagId: string; liveTagId: string; noteIds: string[] };
export async function findStrandedModuleTags(module: string, workspaceId?: string): Promise<StrandedModuleTag[]> {
  const rows = (await sql<{ workspace_id: string; trashed_id: string; live_id: string; notes: string[] }>`
    SELECT old.workspace_id, old.id AS trashed_id, cur.id AS live_id, array_agg(n.id::text ORDER BY n.created_at, n.id) AS notes
      FROM content_nodes old
      JOIN content_nodes cur ON cur.workspace_id = old.workspace_id AND ${sql.raw(liveTagNodeSql("cur"))}
                            AND jsonb_extract_path_text(cur.tag_schema, 'module') = ${module}
      JOIN node_tags nt ON nt.tag_id = old.id
      JOIN content_nodes n ON n.id = nt.node_id AND ${sql.raw(liveNodeSql("n"))} AND n.parent_id IS NULL
     WHERE ${sql.raw(tagNodeSql("old"))} AND old.deleted_at IS NOT NULL AND jsonb_extract_path_text(old.tag_schema, 'module') = ${module}
       AND (${workspaceId ?? null}::uuid IS NULL OR old.workspace_id = ${workspaceId ?? null}::uuid)
       AND NOT EXISTS (SELECT 1 FROM node_tags on2 WHERE on2.node_id = n.id AND on2.tag_id = cur.id)
     GROUP BY old.workspace_id, old.id, cur.id`.execute(db)).rows;
  return rows.map((r) => ({ workspaceId: r.workspace_id, trashedTagId: r.trashed_id, liveTagId: r.live_id, noteIds: r.notes }));
}

/** A module tag a member makes on first use — capture's 收件匣 (modules/capture/inboxTag) —
 *  unlike ensureModuleTag, the owner turning a library module on. Runs inside
 *  the caller's event transaction after it re-checked the tag is still missing.
 *  The tag is named the first of `names` no other top-level tag has, created
 *  through the spine (any_space_write) so its birth is an attributed event, and
 *  is not inheritable. "Member" is who may make it, not whose it is: there is ONE such
 *  tag per workspace, with the id `derivedIdName.moduleTag(workspace, module)`. */
export async function createMemberModuleTag(
  actor: ActorCtx, workspaceId: string,
  { module, names, uiContext }: { module: string; names: readonly string[]; uiContext: string },
): Promise<string> {
  const taken = new Set((await q<{ title: string }>(
    `SELECT title FROM content_nodes
      WHERE workspace_id = $1 AND ${tagNodeSql()} AND parent_id IS NULL AND ${liveNodeSql()}`,
    [workspaceId],
  )).rows.map((row) => row.title));
  const name = names.find((candidate) => !taken.has(candidate)) ?? names[names.length - 1]!;
  const id = await newIdFor("content_nodes", derivedIdName.moduleTag(workspaceId, module));
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "any_space_write" },
    event: {
      type: "TAG_CREATED",
      targetType: "tag",
      targetId: id,
      payload: { name, module },
      txMeta: { ui_context: uiContext },
    },
    apply: async () => {
      await insertTagRow(workspaceId, {
        id, title: name, color: null,
        schema: { ...buildTagSchema({ name, slug: `module-${id}`, publishCollection: false }), module },
      });
    },
  });
  return id;
}

/** No notes, child tags, fields or saved views. */
async function tagUnused(workspaceId: string, tagId: string): Promise<boolean> {
  const row = (await q<{ unused: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM node_tags WHERE tag_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = t.id AND ${liveNodeSql("c")})
        AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.tag_schema->'fields') = 'array' THEN t.tag_schema->'fields' END), 0) = 0
        AND NOT EXISTS (SELECT 1 FROM function_refs fr WHERE fr.holder_node_id = t.id AND fr.instance <> '') AS unused
       FROM content_nodes t WHERE t.workspace_id = $1 AND t.id = $2`,
    [workspaceId, tagId],
  )).rows[0];
  return row?.unused ?? false;
}

/** The module's tag (findModuleTag), adopting a named one — it becomes the
 *  module tag, its notes and name stay — or creating a new tag from the
 *  module's template, named `name` or the module's default. Runs inside the
 *  caller's event transaction; adopting and creating take the principal admin
 *  gate. */
export async function ensureModuleTag(actor: ActorCtx, workspaceId: string, module: string, requestedName?: string): Promise<string> {
  const spec = moduleTagSpecs.get(module);
  if (!spec) throw new ModuleLibraryError(400, `module has no tag: ${module}`);
  let name = requestedName || spec.name;
  let found = await findModuleTag(workspaceId, module, name, { lock: true });
  if (found?.marked) return found.id;
  if (found && spec.unusedOnly && !(await tagUnused(workspaceId, found.id))) {
    name = spec.unusedOnly.otherwise;
    found = null;
  }
  if (found) {
    await changeTagSchema({
      actor, workspaceId, tag: { id: found.id, title: found.title, tag_schema: found.tag_schema },
      patch: { module }, whenNew: "private", uiContext: "module.import",
    });
    return found.id;
  }
  const tagId = await newIdFor("content_nodes", derivedIdName.moduleTag(workspaceId, module));
  await mutate({
    actor, workspaceId, authority: { kind: "principal_admin" },
    event: { type: "TAG_IMPORTED", targetType: "tag", targetId: tagId, payload: { name, from_format: "module", module } },
    apply: async () => {
      const template = spec.template ?? {};
      const schema = {
        ...buildTagSchema({
          name, slug: `module-${tagId}`, publishCollection: false,
          fields: normalizeFieldIdentifiers(template.fields) ?? [], behaviour: template.behaviour ?? {},
          description: template.description, version: template.version,
        }),
        module,
      };
      await insertTagRow(workspaceId, { id: tagId, title: name, color: template.color ?? null, schema });
    },
  });
  return tagId;
}
