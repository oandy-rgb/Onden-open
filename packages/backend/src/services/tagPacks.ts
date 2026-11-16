// TagPack format + install — shared by the owner's direct POST /api/tags/import
// and the agent's approve-before-apply path (proposeTagPack tool → outbox
// 'tag_pack' held effect → installTagPackApproved on approval). A pack is the
// unit of capability: schema fields + behaviour (the ECA the #review
// module reads) + template children — which is why installing one is gated at
// principal-admin directly, and at inbox approval for agents.

import { event, pool, q } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { mutate, requireActor } from "../spine/mutate.js";
import { assertAuthority } from "../spine/authority.js";
import { getWorkspaceId } from "../db.js";
import { slugify, isUuid, isTagNameShape } from "@onden/markdown";
import { buildTagSchema, insertTagRow } from "./tagWrites.js";
import { AttributeWriteError } from "./attributeChange.js";
import { presentModuleIds } from "./moduleCatalog.js";
import type { ActorCtx } from "../types.js";
import { canSeeTag } from "./readPolicy.js";
import { assertTagNameAvailable, liveTagIdByName, TagNameConflictError } from "./tagHierarchy.js";
import { functionIndex, insertFunctionRefs, jsonObject, registeredFunctionIds } from "./functionRefs.js";
import { randomUUID } from "node:crypto";
import { enqueueEffect, PermanentOutboxFailure, registerOutboxEffect, requireString, type Executor } from "./outbox.js";
import { fieldShapeProblems } from "./fieldSchema.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";

export type TagPack = {
  /** Offline-parity: a client-minted class_tag id. Absent → server mints. Lets
   *  the sidebar create an optimistic tag and navigate straight to it, the id
   *  reconciling on /api/sync. Validated as a UUID at the import route. */
  id?: string;
  name: string;
  color?: string;
  description?: string;
  version?: string;
  dependencies?: string[];
  /** Legacy: older packs carried an access policy. Ignored — spaces decide access. */
  policy?: unknown;
  fields?: unknown[];
  behaviour?: Record<string, unknown>;
  /** Sub-tree template — children to spawn under the node on apply. See
   *  services/templateExpander.ts for the format and idempotency rules. */
  template_children?: unknown[];
  /** Module ids whose function backs this tag (#review → ["review"]) —
   *  stamped by the export endpoint from the registry. Import never blocks on
   *  these (contract #10): absent modules degrade the tag to an ordinary
   *  schema tag, surfaced as a missing_modules warning. */
  modules?: string[];
  /** False preserves a capability tag's private collection surface across
   * export, direct import and approval. It does not alter note read policy. */
  publish_collection?: boolean;
  _format?: string;
};

// One identifier convention for schema fields: `name`. TagPack JSON in the
// wild carried the identifier under `key`, but every read path — backend
// (collections value typing, rollups, publish title pick) and the frontend
// consumers — reads `name`, so a key-only field was invisible to all of them.
// Normalize at the write boundary (import + PATCH); migration 056 backfilled
// rows written before this existed.
export function normalizeFieldIdentifiers(fields: unknown[] | undefined): unknown[] | undefined {
  if (!fields) return fields;
  return fields.map((f) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) return f;
    const { key, ...rest } = f as Record<string, unknown>;
    if (typeof key !== "string" || key.length === 0) return f;
    const name = typeof rest.name === "string" && rest.name.length > 0 ? rest.name : key;
    return { ...rest, name };
  });
}

export function validateTagPack(input: unknown): { ok: true; pack: TagPack } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "body must be a JSON object" };
  const pack = input as Record<string, unknown>;
  if (typeof pack.name !== "string" || pack.name.trim().length === 0) {
    return { ok: false, error: "pack.name (string) is required" };
  }
  // The pack's tag gets this name: the one tag-name shape every create and
  // rename asks (tagHierarchy.ts). It used to be the hashtag charset, which
  // refused a pack exported from a tag named "reading list".
  if (!isTagNameShape(pack.name)) {
    return { ok: false, error: "pack.name cannot contain / # , : { } or a line break, or start or end with a space" };
  }
  if (pack.modules !== undefined
      && (!Array.isArray(pack.modules) || pack.modules.some((m) => typeof m !== "string"))) {
    return { ok: false, error: "pack.modules must be an array of module id strings" };
  }
  if (pack.publish_collection !== undefined && typeof pack.publish_collection !== "boolean") {
    return { ok: false, error: "pack.publish_collection must be a boolean" };
  }
  // The same field shape check insertTagRow applies, here so an
  // import or an agent's proposal is refused with the bad paths before
  // anything is queued.
  if (pack.fields !== undefined && !Array.isArray(pack.fields)) {
    return { ok: false, error: "pack.fields must be a list" };
  }
  const fields = normalizeFieldIdentifiers(pack.fields as unknown[] | undefined);
  const fieldProblems = fieldShapeProblems(fields, []);
  if (fieldProblems.length) return { ok: false, error: `invalid fields: ${fieldProblems.join("; ")}` };
  return { ok: true, pack: pack as TagPack };
}

/** Install a pack whose authorization is an inbox APPROVAL (EFFECT_APPROVED by
 *  a principal admin) rather than the caller's own authority — runs from the
 *  outbox drain, attributed to the REQUESTING agent for provenance. Direct
 *  event() is correct here (outbox-perform category): the spine gate already
 *  recorded the approval; this is the approved effect executing. Throws
 *  TagNameConflictError on a root-name collision (the proposal raced an identical manual create) so the
 *  outbox surfaces the failure instead of silently double-installing. */
export async function installTagPackApproved(
  workspaceId: string,
  requestedBy: { actorId: string; actorType: "user" | "ai_agent" | "system" },
  pack: TagPack,
): Promise<{ id: string; name: string }> {
  // Idempotency under at-least-once outbox retry (M6): if a tag with this name
  // already exists, distinguish a prior, crash-interrupted run of THIS effect
  // (which committed the tag but didn't mark the outbox row done) from a genuine
  // race with a manual create. The former carries a TAG_IMPORTED via_approval
  // event — converge on it instead of throwing (a throw dead-letters an effect
  // that actually succeeded). The latter (no approval event) is a real
  // collision and must still surface.
  // A pack installs at the root, so the name rule is the root's (tagHierarchy).
  const existingId = await liveTagIdByName(workspaceId, null, pack.name);
  if (existingId) {
    const byApproval = await pool.query(
      `SELECT 1 FROM domain_events
        WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'TAG_IMPORTED'
          AND payload->>'via_approval' = 'true' LIMIT 1`,
      [workspaceId, existingId],
    );
    if (byApproval.rows[0]) return { id: existingId, name: pack.name }; // prior run already installed it
    throw new TagNameConflictError();
  }
  // Lock before inserting the tag so TAG_IMPORTED cannot take an id that a
  // concurrent writer's sync cursor has already passed.
  return withEventTransaction(workspaceId, async () => {
    const switches = await packModuleSwitches(workspaceId, pack.behaviour);
    const tag = await insertPackTag(workspaceId, pack, undefined, switches.extends, switches.functions).catch((error: unknown) => {
      // A field name outside the key grammar (tagWrites FieldNameRule) fails
      // every attempt the same way: bury it at once with the reason.
      if (error instanceof AttributeWriteError && error.code === "invalid_key") throw new PermanentOutboxFailure(`tag pack refused: ${error.message}`);
      throw error;
    });
    await event(
      workspaceId, "TAG_IMPORTED", "tag", tag.id,
      {
        name: pack.name,
        version: pack.version ?? "1.0.0",
        from_format: pack._format ?? "proposal",
        via_approval: true,
        ...packModulesPayload(pack),
        ...(switches.module_switches.length ? { module_switches: switches.module_switches } : {}),
      },
      requestedBy.actorType, requestedBy.actorId,
    );
    return { id: tag.id, name: tag.title };
  });
}

/** What a pack's module switches (`behaviour.modules.<id>.enabled`) become.
 *  A tag gets a module today by extending the module's tag (#複習 for review),
 *  so each switch that is on, for a registered tag function (the ids
 *  setTagModules accepts) whose module tag is live here, becomes an extends of
 *  that tag. The switch itself is never stored (tagWrites keepModuleSwitches).
 *  The rest are dropped, each reported, never refused: a pack never blocks on
 *  modules (contract #10, like missing_modules). Shared by the owner's import
 *  and the approved proposal, so the same pack stores the same tag. Example:
 *  { modules: { review: { enabled: true }, nope: { enabled: true } } } →
 *  { extends: [<#複習>], module_switches: [{ module: "nope", result:
 *  "unknown_module" }, { module: "review", result: "extends" }] }. */
export async function packModuleSwitches(workspaceId: string, behaviour: unknown): Promise<{
  extends: string[];
  /** The function references the tag gets (insertPackTag): each with the module tag its settings come from. */
  functions: Array<{ functionId: string; sourceTagId: string }>;
  module_switches: Array<{ module: string; result: "extends" | "unknown_module" | "no_module_tag" | "not_enabled" }>;
}> {
  const known = new Set(registeredFunctionIds());
  const extendsIds: string[] = [];
  const functions: Array<{ functionId: string; sourceTagId: string }> = [];
  const report: Array<{ module: string; result: "extends" | "unknown_module" | "no_module_tag" | "not_enabled" }> = [];
  // Sorted: a proposal's pack has been through jsonb, which reorders keys.
  for (const module of Object.keys(jsonObject(jsonObject(behaviour).modules)).sort()) {
    if (!known.has(module)) { report.push({ module, result: "unknown_module" }); continue; }
    if (jsonObject(jsonObject(jsonObject(behaviour).modules)[module]).enabled !== true) { report.push({ module, result: "not_enabled" }); continue; }
    const moduleTag = (await q<{ id: string }>(
      `SELECT id FROM content_nodes
        WHERE workspace_id = $1 AND ${liveTagNodeSql()} AND tag_schema->>'module' = $2
        ORDER BY created_at LIMIT 1`,
      [workspaceId, module],
    )).rows[0];
    if (!moduleTag) { report.push({ module, result: "no_module_tag" }); continue; }
    if (!extendsIds.includes(moduleTag.id)) extendsIds.push(moduleTag.id);
    functions.push({ functionId: module, sourceTagId: moduleTag.id });
    report.push({ module, result: "extends" });
  }
  return { extends: extendsIds, functions, module_switches: report };
}

/** Insert the class_tag a pack installs, its schema folded onto the node
 *  (P4.1 CONTRACT: no separate collection_schemas row). Shared by the owner's
 *  POST /api/tags/import and the approved proposal; each records its own
 *  TAG_IMPORTED. A pack that keeps out of the published collections gets a
 *  UUID schema slug, like any capability-only tag. `extendsIds` are the
 *  module tags its switches became (packModuleSwitches). */
export async function insertPackTag(workspaceId: string, pack: TagPack, tagId: string = randomUUID(), extendsIds: string[] = [], functions: Array<{ functionId: string; sourceTagId: string }> = []) {
  const schema = buildTagSchema({
    name: pack.name, slug: pack.publish_collection === false ? `module-${tagId}` : slugify(pack.name),
    fields: normalizeFieldIdentifiers(pack.fields) ?? [],
    views: {},
    behaviour: pack.behaviour ?? {},
    description: pack.description ?? "",
    version: pack.version ?? "1.0.0",
    dependencies: pack.dependencies ?? [],
    templateChildren: pack.template_children ?? [],
    publishCollection: pack.publish_collection,
  });
  const tag = await insertTagRow(workspaceId, {
    id: tagId,
    title: pack.name,
    color: pack.color ?? "#888888",
    schema: extendsIds.length ? { ...schema, extends: extendsIds } : schema,
  });
  await insertFunctionRefs(workspaceId, tag.id, functions);
  return tag;
}

/** Module binding (contract #10) for a TAG_IMPORTED payload: the modules the
 *  pack declares and those this build doesn't ship. Import still succeeds
 *  without them — the tag degrades to an ordinary schema tag. */
export function packModulesPayload(pack: TagPack): { modules?: string[]; missing_modules?: string[] } {
  if (!pack.modules?.length) return {};
  const present = presentModuleIds();
  return { modules: pack.modules, missing_modules: pack.modules.filter((id) => !present.has(id)) };
}

// ── TagPack export ───────────────────────────────────────────────────────────
//
// A portable JSON representation of a tag — Schema (fields), Behaviour, plus
// library metadata (version, description, dependencies). This is the format
// the import endpoint consumes. Anyone who can see the tag can export it;
// null when the tag is missing or hidden (404, no existence oracle).
export async function exportTagPack(actor: ActorCtx, workspaceId: string, id: string): Promise<Record<string, unknown> | null> {
  if (!(await canSeeTag(actor, id))) return null;
  const result = await pool.query<{
    name: string; color: string;
    fields: unknown; behaviour: unknown;
    description: string; version: string; dependencies: string[];
    template_children: unknown;
    publish_collection: boolean | null;
  }>(
    // A1.4: read from content_nodes shadow; preserve TagPack output shape.
    // A1.4 → P4.1: read from the node's own tag_schema shadow. dependencies is
    // stored as a jsonb array (to_jsonb of the text[]); COALESCE its default to
    // '[]'::jsonb (node-pg still deserialises a jsonb string array to string[]).
    // Every schema column is NOT NULL on collection_schemas, so the shadow never
    // holds a JSON-null for these keys — COALESCE only fires when the node has no
    // schema at all (tag_schema IS NULL), exactly as the old LEFT JOIN miss did.
    `SELECT n.title  AS name, n.tag_color AS color,
            COALESCE(n.tag_schema->'fields', '[]'::jsonb)             AS fields,
            COALESCE(n.tag_schema->'behaviour', '{}'::jsonb)          AS behaviour,
            COALESCE(n.tag_schema->>'description', '')                AS description,
            COALESCE(n.tag_schema->>'version', '1.0.0')              AS version,
            COALESCE(n.tag_schema->'dependencies', '[]'::jsonb)      AS dependencies,
            COALESCE(n.tag_schema->'template_children', '[]'::jsonb)  AS template_children,
            n.tag_schema->'publish_collection'                     AS publish_collection
     FROM content_nodes n
     WHERE n.workspace_id = $1 AND n.id = $2
       AND ${liveTagNodeSql("n")}`,
    [workspaceId, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  // The tag functions it has travel with the schema when a pack is renamed:
  // by a legacy switch or by extending a module's tag. Nothing infers a
  // module from a tag's title or reserved key (RSS's #subscription binding
  // went with migration 114). The importing build can warn about
  // unavailable capabilities. Tag functions travel as switches in behaviour,
  // the portable form: an import turns them back into extends of that
  // workspace's module tags (packModuleSwitches), as tag ids do not travel.
  const index = await functionIndex(null, workspaceId);
  const modules = registeredFunctionIds().filter((module) => index.has(id, module));
  const stored = jsonObject(row.behaviour);
  const behaviour = modules.length === 0 ? stored : {
    ...stored,
    modules: { ...jsonObject(stored.modules), ...Object.fromEntries(modules.map((module) => [module, { enabled: true }])) },
  };
  // Output is a minimal, stable shape — keep it forward-compatible by being
  // explicit about every field. Importers can rely on this structure.
  return {
    name: row.name,
    color: row.color,
    description: row.description,
    version: row.version,
    dependencies: row.dependencies ?? [],
    fields: row.fields ?? [],
    behaviour,
    template_children: row.template_children ?? [],
    ...(modules.length > 0 ? { modules } : {}),
    ...(typeof row.publish_collection === "boolean" ? { publish_collection: row.publish_collection } : {}),
    // Format tag — version this exporter, not the pack itself. Helps future
    // importers detect packs from before a known format change.
    _format: "onden.tagpack/v1",
  };
}

// ── The agent's path: proposed, held, installed on approval ────────────────
// The tag_pack effect kind lives here, beside the install it runs, the way
// modules register their own kinds — the outbox stays generic.

/** Agent-proposed tag pack (proposeTagPack tool) — held until a principal
 *  admin approves it in the inbox; only then does the install run. The
 *  approve-before-apply rail (outbox status='pending_approval'). */
export async function enqueueTagPackProposal(opts: {
  workspaceId: string;
  pack: Record<string, unknown>;
  requestedByActorId: string;
  requestedByActorType: "user" | "ai_agent" | "system";
}, exec?: Executor): Promise<void> {
  await enqueueEffect({
    workspaceId: opts.workspaceId, kind: "tag_pack", held: true,
    dedupKey: `tag_pack:${opts.workspaceId}:${String(opts.pack.name ?? "")}`,
    payload: {
      workspaceId: opts.workspaceId,
      pack: opts.pack,
      requestedByActorId: opts.requestedByActorId,
      requestedByActorType: opts.requestedByActorType,
    },
  }, exec);
}

type RequesterType = "user" | "ai_agent" | "system";
const requesterType = (value: unknown): RequesterType =>
  value === "user" || value === "system" ? value : "ai_agent";

function approvedPack(stored: unknown): TagPack {
  const validation = validateTagPack(stored);
  if (!validation.ok) throw new PermanentOutboxFailure(`tag pack refused: ${validation.error}`);
  return validation.pack;
}

registerOutboxEffect({
  kind: "tag_pack",
  // tag_pack installs a schema + policy + BEHAVIOUR (module settings) — the same
  // authoring power POST /api/tags/import reserves to the owner (who is also
  // the only reviewer).
  // The pack is checked again here: one queued before a validation rule
  // existed (T9's behaviour check) would fail every attempt the same way, so
  // it is buried as dead at once with the reason instead of retried for a day.
  parse: (p) => ({
    workspaceId: requireString(p, "workspaceId"), pack: approvedPack(p.pack),
    requestedByActorId: requireString(p, "requestedByActorId"), requestedByActorType: requesterType(p.requestedByActorType),
  }),
  perform: async (p) => {
    await installTagPackApproved(p.workspaceId, { actorId: p.requestedByActorId, actorType: p.requestedByActorType }, p.pack);
  },
});


// ── The owner's pack install (POST /api/tags/import, depth audit D13) ───────
// Accepts a TagPack JSON (the format produced by /export). Two gates:
//   1. install-time policy gate — if the pack carries a required_role, the
//      importing actor must satisfy it for the "apply" op. This is the moat
//      vs npm-style libraries: an admin-required pack can't be installed by
//      a viewer, even if the pack is public.
//   2. dependency declaration — any slugs in pack.dependencies that aren't
//      already present emit a TAG_DEPENDENCY_MISSING event (warn, don't block).
//      The user-facing UI can surface these.
//
// Naming policy: if a root tag with the same exact name exists, return 409
// tag_name_conflict (tagHierarchy.assertTagNameAvailable). The importer should rename in the JSON before re-posting. Future Tier 2 can add
// an "upgrade" semantic that detects the existing tag and offers to replace.
//
// TagPack type + validateTagPack + normalizeFieldIdentifiers moved to
// services/tagPacks.ts — shared with the agent's proposeTagPack approval path.


/** A refused install, with the status and the body the API answers. */
export class TagPackRefusal extends Error {
  constructor(readonly status: 400, readonly body: Record<string, unknown>) {
    super(String(body.error)); this.name = "TagPackRefusal";
  }
}

/** Install a pack as the workspace owner. `readPack` reads the request body
 *  (null when it isn't JSON); it runs only after the owner check. Answers the
 *  new tag, the missing dependencies / modules (warnings) and what became of
 *  the pack's module switches (packModuleSwitches); throws
 *  TagPackRefusal (400 invalid pack or id) or TagNameConflictError (409, the
 *  name is taken at the root). */
export async function installTagPack(authenticated: ActorCtx | null, readPack: () => Promise<unknown>) {
  const actor = requireActor(authenticated);
  // SECURITY: importing a pack CREATES a schema + policy + behaviour — the
  // same authoring power PATCH /:id/schema reserves to the workspace owner.
  // Without this gate any editor/viewer could plant a schema or policy via
  // import while being barred from the editor (audit 2026-06-10 #2).
  await assertAuthority(actor, { kind: "principal_admin" });
  const workspaceId = await getWorkspaceId();

  const raw = await readPack();
  const validation = validateTagPack(raw);
  if (!validation.ok) throw new TagPackRefusal(400, { error: validation.error });
  const { pack } = validation;

  // Offline-parity: honor a client-minted class_tag id so the sidebar's optimistic
  // tag reconciles by id (it navigates straight to the new tag's node). Absent →
  // server mints. Validate here so a malformed id 400s instead of 500ing on the cast.
  const clientId = typeof pack.id === "string" ? pack.id : null;
  if (clientId !== null && !isUuid(clientId)) {
    throw new TagPackRefusal(400, { error: "bad_request", detail: "id must be a UUID" });
  }

  // The pack's tag lands at the root: a root tag with this exact name answers
  // 409 tag_name_conflict (the shared rule and error, tagHierarchy.ts).
  await assertTagNameAvailable(workspaceId, null, { title: pack.name, parentId: null });

  // Dependency warnings — non-blocking. Future Tier 3 can offer auto-fetch
  // semantics (npm-install style).
  const missingDeps: string[] = [];
  if (pack.dependencies && pack.dependencies.length > 0) {
    // P4.1: dependency presence is a class_tag-node lookup by the schema slug on
    // the tag_schema shadow (1:1 with collection_schemas after migration 075).
    const present = await pool.query<{ slug: string }>(
      `SELECT n.tag_schema->>'slug' AS slug FROM content_nodes n
        WHERE n.workspace_id = $1 AND ${liveTagNodeSql("n")}
          AND n.tag_schema->>'slug' = ANY($2)`,
      [workspaceId, pack.dependencies],
    );
    const presentSet = new Set(present.rows.map((r) => r.slug));
    for (const dep of pack.dependencies) {
      if (!presentSet.has(dep)) missingDeps.push(dep);
    }
  }

  // Module binding (contract #10): a missing module never blocks the import;
  // the response carries a missing_modules warning for the UI.
  const modules = packModulesPayload(pack);
  // Module switches become extends of the module tags (packModuleSwitches);
  // those that cannot are reported.
  const switches = await packModuleSwitches(workspaceId, pack.behaviour);

  // Through the spine (audit 2026-06-10 #2): authority backstop + an
  // attributed TAG_IMPORTED event atomic with the insert.
  const created = await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    timing: "after",
    event: {
      type: "TAG_IMPORTED",
      targetType: "tag",
      targetId: (r: { id: string }) => r.id,
      payload: {
        name: pack.name,
        version: pack.version ?? "1.0.0",
        from_format: pack._format ?? "unknown",
        ...modules,
        ...(switches.module_switches.length ? { module_switches: switches.module_switches } : {}),
      },
    },
    apply: async () => {
      const tag = await insertPackTag(workspaceId, pack, clientId ?? undefined, switches.extends, switches.functions);
      for (const dep of missingDeps) {
        await event(
          workspaceId, "TAG_DEPENDENCY_MISSING", "tag", tag.id,
          { tag_name: pack.name, missing_dependency: dep },
          "system", actor.id,
        );
      }
      return tag;
    },
  });

  return {
    id: created.id,
    name: created.title,
    color: created.color,
    missing_dependencies: missingDeps,
    missing_modules: modules.missing_modules ?? [],
    module_switches: switches.module_switches,
  };
}
