// The workspace's reserved tag `key` (#page…) for fixtures: found by role,
// adopted from a root tag of that title, else created with the key — never by
// title alone, which since migration 100 is an ordinary tag. "task" is the
// tasks module's tag (migration 135): found by the module mark, else a root
// tag titled task gets the mark, else one is created marked.

import { randomUUID } from "node:crypto";

import { adoptReservedTag, reservedTagId, type ReservedTagKey } from "../../services/reservedTags.js";
import { seedQ } from "./seedQ.js";

export async function reservedTagFixture(workspaceId: string, key: ReservedTagKey | "task"): Promise<string> {
  if (key === "task") return taskTagFixture(workspaceId);
  const found = await reservedTagId(workspaceId, key) ?? await adoptReservedTag(workspaceId, key);
  if (found) return found;
  const r = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, reserved_key)
     VALUES ($1, 'manual', 'class_tag', $2, $3, '', $2) RETURNING id`,
    [workspaceId, key, `tag-${key}-${randomUUID().slice(0, 8)}`],
  );
  return r.rows[0]!.id;
}

/** The tasks module's tag (live, marked by tag_schema.module); null when the workspace has none. Tasks do not need it. */
export async function taskModuleTagId(workspaceId: string): Promise<string | null> {
  return (await seedQ<{ id: string }>(
    `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL
        AND tag_schema->>'module' = 'tasks' ORDER BY created_at, id LIMIT 1`, [workspaceId])).rows[0]?.id ?? null;
}

const TASKS_SCHEMA = `'{"name":"task","slug":"module-task","fields":[],"policy":{},"behaviour":{},"template_children":[],"views":{},"block_template":[],"description":"","version":"1.0.0","dependencies":[],"publish_collection":false,"module":"tasks"}'::jsonb`;

/** A module tag holds the module's own function (tagWrites.insertTagRow), which is how the line word `{task}` finds it. */
async function holdsOwnFunction(workspaceId: string, tagId: string): Promise<string> {
  await seedQ(
    `INSERT INTO function_refs (workspace_id, function_id, holder_node_id)
     SELECT $1, 'tasks', $2::uuid WHERE NOT EXISTS (
       SELECT 1 FROM function_refs WHERE holder_node_id = $2::uuid AND function_id = 'tasks' AND instance = '')`, [workspaceId, tagId]);
  return tagId;
}

async function taskTagFixture(workspaceId: string): Promise<string> {
  const found = await taskModuleTagId(workspaceId);
  if (found) return holdsOwnFunction(workspaceId, found);
  const adopted = await seedQ<{ id: string }>(
    `UPDATE content_nodes SET tag_schema = ${TASKS_SCHEMA}
      WHERE id = (SELECT id FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL
                     AND parent_id IS NULL AND title = 'task' AND (tag_schema IS NULL OR tag_schema->>'module' IS NULL)
                   ORDER BY created_at, id LIMIT 1)
      RETURNING id`, [workspaceId]);
  if (adopted.rows[0]) return holdsOwnFunction(workspaceId, adopted.rows[0].id);
  const r = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
     VALUES ($1, 'manual', 'class_tag', 'task', $2, '', ${TASKS_SCHEMA}) RETURNING id`,
    [workspaceId, `tag-task-${randomUUID().slice(0, 8)}`],
  );
  return holdsOwnFunction(workspaceId, r.rows[0]!.id);
}
