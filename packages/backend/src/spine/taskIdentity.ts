// What makes a node a task, and where a task is read from. Core, not the tasks
// module (modules/tasks): read policy, space scope, sync, trash and export all
// have to recognise task nodes whether or not the module is on — its data is
// kept when the owner turns it off.
//
// A task is a hidden node that references the tasks function (a function_refs
// row, holder = the node, function_id = 'tasks'; migration 191 — it carried the
// tasks module's tag before) and carries a `_task_status` attribute. It has a host note
// (parent_id) when it is a line of that note, and none when it is a
// standalone task, which then lives in its own space (content_nodes.space_id,
// the creator's personal space unless named). Who may read or write it is the
// ordinary space rule for the node itself — the database keeps a task in its
// host's space (migration 093), so host and own space are the same answer.
import { TASK_ATTR, TASKS_MODULE_ID } from "@onden/markdown";
import { liveNodeSql, notTagNodeSql } from "./nodeSql.js";

// Shared with the app (@onden/markdown sharedContract): the module id.
export { TASKS_MODULE_ID };

/** The reserved word `{task}` on a checkbox line (docs/architecture/block-nodes.md B4). The tasks
 *  module recognises it itself; it is never resolved to a tag, so saving a note can not make a
 *  plain `task` tag. Also the name no user tag may take (tagHierarchy RESERVED_TITLES). */
export const TASK_TAG_NAME = "task";
/** The reserved `_task_*` attribute keys (@onden/markdown TASK_ATTR, shared with the app). */
export const K = TASK_ATTR;

/** The function id a task node references (the module id, as the tag-level function has). */
export const TASK_FUNCTION_ID = TASKS_MODULE_ID;

/** "Does the note `alias` reference the tasks function?" Written to use the partial index
 *  function_refs_holder_node_idx (migration 188). A tag node is never one: the tasks module's own tag holds the same
 *  function (function_refs gives every module tag its own function) and must stay in node lists and sync like any tag.
 *  `alias` is a trusted SQL alias, never request input. */
export function hasTaskRefSql(alias: string): string {
  return `(${notTagNodeSql(alias)} AND EXISTS (
    SELECT 1 FROM function_refs task_ref
    WHERE task_ref.holder_node_id = ${alias}.id AND task_ref.function_id = '${TASK_FUNCTION_ID}' AND task_ref.instance = ''))`;
}

/** The same task identity as tasksStore's row projection: the tasks reference plus
 *  status. `alias` is a trusted content_nodes SQL alias, never request input. */
export function isTaskSql(alias: string): string {
  return `(${hasTaskRefSql(alias)} AND EXISTS (
    SELECT 1 FROM node_attributes scope_status
    WHERE scope_status.node_id = ${alias}.id AND scope_status.key = '${K.status}'))`;
}

/** A live task is readable only while its host note is live (a task in a
 *  trashed note is trashed with it, for readers). A standalone task (no
 *  parent) has no host to wait for. `alias` is a trusted alias. */
export function taskHostLiveSql(alias: string): string {
  return `(${alias}.parent_id IS NULL OR NOT ${isTaskSql(alias)} OR EXISTS (
    SELECT 1 FROM content_nodes task_host
    WHERE task_host.id = ${alias}.parent_id AND ${liveNodeSql("task_host")}))`;
}
