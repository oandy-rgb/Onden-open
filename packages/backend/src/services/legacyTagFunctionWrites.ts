// The two tag-function writes the previous frontend release sends (PUT /api/tags/:id/extends and
// PATCH /api/tags/:id/modules), kept so a browser tab or installed PWA still running that release keeps
// working after the deploy (test/clientWritesReplay.integration.test.ts holds the deploy to it).
// Both are answered by the function reference operations (services/functionRefs.ts): an extends of a
// module tag is "this tag has that module's function", a module switch is the same for the tag itself.
// Delete this file with the routes once no kept release in test/fixtures/client-writes sends them.

import { isUuid } from "@onden/markdown";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { assertAuthority } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { canSeeTag } from "./readPolicy.js";
import { changeTagSchema } from "./tagWrites.js";
import {
  addFunction, lockTag, FunctionRefError, functionsOf, jsonObject, loadExtendsGraph, registeredFunctionIds, removeFunction,
  wouldCreateExtendsCycle,
} from "./functionRefs.js";
import { isViewLayout } from "./viewLayouts.js";
import { extendsIdsOf } from "./tagExtendsList.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";

/** PUT /api/tags/:id/extends: set what the tag extends. A module tag among the targets gives the tag that
 *  module's function; one dropped takes the function it gave away. */
export function putTagExtends(input: { actor: ActorCtx; workspaceId: string; tagId: string; extends: string[] }): Promise<{ id: string; extends: string[] }> {
  const { workspaceId, tagId } = input;
  const targets = [...new Set(input.extends)];
  if (targets.some((id) => !isUuid(id))) return Promise.reject(new FunctionRefError(400, "extends lists tag ids"));
  if (targets.includes(tagId)) return Promise.reject(new FunctionRefError(400, "a tag cannot extend itself"));
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    await assertAuthority(actor, { kind: "principal_admin" });
    if (!(await canSeeTag(actor, tagId))) throw new FunctionRefError();
    const tag = await lockTag(workspaceId, tagId);
    if (!tag) throw new FunctionRefError();
    const targetRows = targets.length ? (await q<{ id: string; module: string | null }>(
      `SELECT id::text, tag_schema->>'module' AS module FROM content_nodes
        WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND ${liveTagNodeSql()}`, [workspaceId, targets],
    )).rows : [];
    for (const target of targets) {
      if (!targetRows.some((row) => row.id === target) || !(await canSeeTag(actor, target))) throw new FunctionRefError(404);
    }
    const previous = extendsIdsOf(tag.tag_schema?.extends);
    const added = targets.filter((id) => !previous.includes(id));
    // A tag has a function by extending a module's tag; a user tag extending a user tag is not new data any more.
    if (added.some((id) => !targetRows.find((row) => row.id === id)?.module)) throw new FunctionRefError(400, "a tag can only extend a module tag");
    if (added.length && wouldCreateExtendsCycle(await loadExtendsGraph(workspaceId), tagId, added)) {
      throw new FunctionRefError(400, "tags cannot extend each other");
    }
    const holder = { kind: "node" as const, id: tagId };
    const gives = (id: string) => {
      const module = targetRows.find((row) => row.id === id)?.module;
      return module && registeredFunctionIds().includes(module) && !isViewLayout(module) ? module : null;
    };
    for (const id of previous.filter((candidate) => !targets.includes(candidate))) {
      for (const use of (await functionsOf(actor, holder)) ?? []) {
        if (use.refId && use.sourceTagId === id) await removeFunction({ actor, workspaceId, refId: use.refId });
      }
    }
    for (const id of added) {
      const module = gives(id);
      if (module) await addFunction({ actor, workspaceId, holder, functionId: module });
    }
    // The list as the caller sent it (its order, a view module's tag): whatever the function writes left differing.
    const fresh = await lockTag(workspaceId, tagId);
    const current = extendsIdsOf(fresh?.tag_schema?.extends);
    if (fresh && (current.length !== targets.length || current.some((id, i) => id !== targets[i]))) {
      await changeTagSchema({ actor, workspaceId, tag: fresh, patch: { extends: targets }, whenNew: "private", uiContext: "tag.extends.put" });
    }
    return { id: tagId, extends: targets };
  });
}

/** PATCH /api/tags/:id/modules: switch the tag's own function on or off. */
export function patchTagModules(input: { actor: ActorCtx; workspaceId: string; tagId: string; modules: Record<string, boolean> }): Promise<{ id: string; behaviour: Record<string, unknown> }> {
  const { workspaceId, tagId, modules } = input;
  const unknown = Object.keys(modules).filter((id) => !registeredFunctionIds().includes(id));
  if (unknown.length) return Promise.reject(new FunctionRefError(400, `unknown tag function: ${unknown.join(", ")}`));
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    const holder = { kind: "node" as const, id: tagId };
    for (const [functionId, on] of Object.entries(modules)) {
      if (on) { await addFunction({ actor, workspaceId, holder, functionId }); continue; }
      await assertAuthority(actor, { kind: "principal_admin" });
      // The tag's own reference (functionsOf lists the refs this tag holds, refId set), whatever tag its
      // settings come from: with a module tag in the workspace addFunction points the source at it, so
      // matching on `sourceTagId === tagId` found nothing and a switch-off answered 200 doing nothing.
      const own = ((await functionsOf(actor, holder)) ?? []).find((use) => use.functionId === functionId && use.refId);
      if (own?.refId) await removeFunction({ actor, workspaceId, refId: own.refId });
    }
    await assertAuthority(actor, { kind: "principal_admin" });
    if (!(await canSeeTag(actor, tagId))) throw new FunctionRefError();
    const stored = (await q<{ behaviour: unknown }>(`SELECT tag_schema->'behaviour' AS behaviour FROM content_nodes WHERE id = $1`, [tagId])).rows[0];
    return { id: tagId, behaviour: jsonObject(stored?.behaviour) };
  });
}
