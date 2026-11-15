/** Event target types whose target_id is a content node id, so node read
 *  policy decides who may see or act on the event. Tasks are nodes since
 *  migration 062; TASK_OCCURRENCE_MISSED was recorded with target_type "task"
 *  until 2026-10-05 and those rows stay in the log; a canvas is a node since
 *  migration 057 and its CANVAS_* events name it as "canvas". Any gate that treats
 *  non-node targets as workspace-wide must use this, or such an event would
 *  bypass the read policy of the node it names. */
export const NODE_TARGET_TYPES = ["node", "task", "canvas"] as const;

export function targetsNode(targetType: string): boolean {
  return (NODE_TARGET_TYPES as readonly string[]).includes(targetType);
}

/** SQL list literal of NODE_TARGET_TYPES, for `target_type IN ${…}` clauses. */
export const NODE_TARGET_TYPES_SQL = `(${NODE_TARGET_TYPES.map((type) => `'${type}'`).join(",")})`;
