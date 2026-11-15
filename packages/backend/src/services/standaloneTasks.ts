// Standalone tasks (T1): a hidden node referencing the tasks function with no host note
// (parent_id null), living in a space like a root note. This is the part of
// the model the Markdown export / import and the backup restore need —
// reading them out for an actor, and making one — without the task routes
// (those are T1's).
//
// Reads go through readableScopeSql like any note: a task with no host is
// live on its own (spine/taskIdentity.ts taskHostLiveSql).
//
// Creation is createNote (hidden, no parent) plus the tasks reference and the
// `_task_*` attributes as raw rows inside its NODE_CREATED transaction — the
// way services/tasksStore.ts insertTaskNodeTx writes a hosted task.

import { randomUUID } from "node:crypto";
import { freeFormType } from "@onden/markdown";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { createNote } from "./noteCreate.js";
import { isTaskSql } from "../spine/taskIdentity.js";
import { addTaskRefTx } from "./tasksStore.js";
import { readableScopeSql } from "./readPolicy.js";
import { STATUS_KEY } from "./taskListFile.js";

export type StandaloneTaskRow = {
  id: string;
  title: string;
  markdown: string;
  created_at: string;
  updated_at: string;
  /** Its `_task_*` attributes by key. */
  fields: Record<string, string>;
};

/** SQL: `alias` is a hidden root node referencing the tasks function. */
export function standaloneTaskSql(alias: string): string {
  return `(${alias}.hidden AND ${alias}.parent_id IS NULL AND ${alias}.node_type = 'content' AND ${isTaskSql(alias)})`;
}

/** The live standalone tasks of `workspaceId` that `actor` may read, oldest first. */
export async function readableStandaloneTasks(actor: ActorCtx | null, workspaceId: string): Promise<StandaloneTaskRow[]> {
  const params: unknown[] = [workspaceId];
  const scope = readableScopeSql(actor, "cn", params);
  const rows = (await q<Omit<StandaloneTaskRow, "fields">>(
    `SELECT cn.id::text, cn.title, COALESCE(cn.markdown, '') AS markdown, cn.created_at::text, cn.updated_at::text
       FROM content_nodes cn
      WHERE cn.workspace_id = $1 AND ${standaloneTaskSql("cn")} AND ${scope}
      ORDER BY cn.created_at, cn.id`,
    params,
  )).rows;
  if (rows.length === 0) return [];
  const attributes = (await q<{ node_id: string; key: string; value: string }>(
    `SELECT node_id::text, key, value FROM node_attributes WHERE node_id = ANY($1::uuid[]) AND key LIKE '\\_task\\_%'`,
    [rows.map((r) => r.id)],
  )).rows;
  return rows.map((r) => ({
    ...r,
    fields: Object.fromEntries(attributes.filter((a) => a.node_id === r.id).map((a) => [a.key, a.value])),
  }));
}

/** The ids among `refIds`-style prefixes (`t-` + 12 hex of a node id) that
 *  are standalone tasks `actor` may read; for matching an imported `^t-…`
 *  back to the task it names. */
export async function readableStandaloneTaskIds(actor: ActorCtx | null, workspaceId: string): Promise<string[]> {
  const params: unknown[] = [workspaceId];
  const scope = readableScopeSql(actor, "cn", params);
  return (await q<{ id: string }>(
    `SELECT cn.id::text FROM content_nodes cn
      WHERE cn.workspace_id = $1 AND ${standaloneTaskSql("cn")} AND ${scope}`,
    params,
  )).rows.map((r) => r.id);
}

export type NewStandaloneTask = {
  actor: ActorCtx;
  workspaceId: string;
  /** Keep this id (a restore keeps the backup's when it is free). */
  id?: string;
  title: string;
  markdown?: string;
  /** Its `_task_*` attributes; a missing status is "todo". */
  fields: Record<string, string>;
  /** The space it lands in; default the creator's personal space. */
  spaceId?: string | null;
  uiContext: string;
  /** Extra NODE_CREATED payload / tx meta (an import's source, a restore's origin). */
  payload?: Record<string, unknown>;
  txMeta?: Record<string, unknown>;
};

/** Create one standalone task and return its id. Space write and size caps
 *  are createNote's; a `_task_*` field is stored as given (its value is typed
 *  as a value, like every task attribute). */
export async function createStandaloneTask(input: NewStandaloneTask): Promise<string> {
  const { actor, workspaceId, fields } = input;
  const attributes = { ...fields, [STATUS_KEY]: fields[STATUS_KEY] || "todo" };
  const id = input.id ?? randomUUID();
  const created = await createNote({
    actor, workspaceId, id, slug: `task-${id}`, title: input.title, markdown: input.markdown ?? "",
    parentId: null, spaceId: input.spaceId, hidden: true, index: false,
    event: { uiContext: input.uiContext, payload: { task: true, standalone: true, ...input.payload }, txMeta: input.txMeta },
    within: async ({ nodeId }) => {
      // The tasks reference is the task's identity, not something to announce, and its fields are
      // system state (see insertTaskNodeTx).
      await addTaskRefTx(workspaceId, nodeId);
      for (const [key, value] of Object.entries(attributes)) {
        if (!key.startsWith("_task_") || value === "") continue;
        await q(
          `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, false, 'ui', now())
           ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value, value_type = EXCLUDED.value_type, updated_at = now()`,
          [workspaceId, nodeId, key, value, freeFormType(value)],
        );
      }
    },
  });
  return String(created.node.id);
}
