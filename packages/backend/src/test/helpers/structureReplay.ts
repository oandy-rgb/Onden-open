// Folding structure_log from its start (each row's new value, in log order) must give what the tables hold now: the
// acceptance test of the triggers that write it (causal-stamps proposal §8.5). Each function returns the differences.
import { q } from "../../db.js";

type LogRow = { row_key: string; field: string; new_value: string | null };

const logOf = async (workspaceId: string, table: string, rowKeys: string[]): Promise<LogRow[]> => (await q<LogRow>(
  `SELECT row_key, field, new_value FROM structure_log
    WHERE workspace_id = $1 AND table_name = $2 AND row_key = ANY($3::text[]) ORDER BY id`, [workspaceId, table, rowKeys])).rows;

/** The cards on one board (node_positions rows of `surface`): the log's last value for each card equals the row. */
export async function boardCardProblems(workspaceId: string, surface: string): Promise<string[]> {
  const rows = (await q<{ key: string; card: string }>(
    `SELECT node_id::text || '/' || surface AS key,
            jsonb_build_object('x', x, 'y', y, 'width', width, 'height', height, 'color', color, 'folded', folded, 'sub_canvas_id', sub_canvas_id)::text AS card
       FROM node_positions WHERE workspace_id = $1 AND surface = $2`, [workspaceId, surface])).rows;
  const logged = (await q<LogRow>(
    `SELECT row_key, field, new_value FROM structure_log
      WHERE workspace_id = $1 AND table_name = 'node_positions' AND row_key LIKE '%/' || $2 ORDER BY id`, [workspaceId, surface])).rows;
  const folded = new Map<string, string | null>();
  for (const r of logged) folded.set(r.row_key, r.new_value);
  const now = new Map(rows.map((r) => [r.key, r.card]));
  const problems: string[] = [];
  for (const key of new Set([...folded.keys(), ...now.keys()])) {
    const replayed = folded.get(key) ?? null;
    const actual = now.get(key) ?? null;
    if (replayed !== actual) problems.push(`card ${key}: the structure log replays to ${replayed}, the table holds ${actual}`);
  }
  return problems;
}

/** The tags of these notes: applying adds `new_value`, removing leaves `old_value` out. */
export async function noteTagProblems(workspaceId: string, nodeIds: string[]): Promise<string[]> {
  if (nodeIds.length === 0) return [];
  const log = (await q<{ row_key: string; old_value: string | null; new_value: string | null }>(
    `SELECT row_key, old_value, new_value FROM structure_log
      WHERE workspace_id = $1 AND table_name = 'node_tags' AND row_key = ANY($2::text[]) ORDER BY id`, [workspaceId, nodeIds])).rows;
  const replayed = new Map<string, Set<string>>(nodeIds.map((id) => [id, new Set()]));
  for (const r of log) {
    const set = replayed.get(r.row_key)!;
    if (r.old_value) set.delete(r.old_value);
    if (r.new_value) set.add(r.new_value);
  }
  const rows = (await q<{ node_id: string; tag_id: string }>(
    `SELECT node_id::text, tag_id::text FROM node_tags WHERE node_id = ANY($1::uuid[])`, [nodeIds])).rows;
  const actual = new Map<string, Set<string>>(nodeIds.map((id) => [id, new Set()]));
  for (const r of rows) actual.get(r.node_id)!.add(r.tag_id);
  const problems: string[] = [];
  for (const id of nodeIds) {
    const [a, b] = [[...replayed.get(id)!].sort(), [...actual.get(id)!].sort()];
    if (a.join() !== b.join()) problems.push(`note ${id}: the structure log replays to tags [${a}], the table holds [${b}]`);
  }
  return problems;
}

/** A board's section frames: the log's last value of the attribute equals the stored value (NULL = none). */
export async function boardSectionProblems(workspaceId: string, boardId: string): Promise<string[]> {
  const log = await logOf(workspaceId, "node_attributes", [`${boardId}/_canvas_sections`]);
  const replayed = log.filter((r) => r.field === "sections").at(-1)?.new_value ?? null;
  const actual = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_canvas_sections'`, [boardId])).rows[0]?.value ?? null;
  return replayed === actual ? [] : [`board ${boardId}: the structure log replays the section frames to ${replayed}, the table holds ${actual}`];
}

/** Every note's tags in one workspace (the notes the log or the table mentions). */
export async function workspaceTagProblems(workspaceId: string): Promise<string[]> {
  const ids = (await q<{ id: string }>(
    `SELECT DISTINCT row_key AS id FROM structure_log WHERE workspace_id = $1 AND table_name = 'node_tags'
     UNION SELECT t.node_id::text FROM node_tags t JOIN content_nodes n ON n.id = t.node_id WHERE n.workspace_id = $1`, [workspaceId])).rows.map((r) => r.id);
  return noteTagProblems(workspaceId, ids);
}

/** A space's capability switches: folding the log's lines for the space (new value per switch, NULL = absent) gives the column's JSON. */
export async function capabilityProblems(workspaceId: string, spaceId: string): Promise<string[]> {
  const log = (await logOf(workspaceId, "spaces", [spaceId])).filter((r) => r.field.startsWith("capability:"));
  const replayed: Record<string, unknown> = {};
  for (const r of log) {
    const key = r.field.slice("capability:".length);
    if (r.new_value === null) delete replayed[key]; else replayed[key] = JSON.parse(r.new_value);
  }
  const actual = (await q<{ capabilities: Record<string, unknown> }>(`SELECT capabilities FROM spaces WHERE id = $1`, [spaceId])).rows[0]?.capabilities ?? {};
  const [a, b] = [JSON.stringify(Object.entries(replayed).sort()), JSON.stringify(Object.entries(actual).sort())];
  return a === b ? [] : [`space ${spaceId}: the structure log replays the switches to ${a}, the column holds ${b}`];
}

/** Who is in a space with which permission: the log's last line for each (space, member) equals the table (NULL = not a member). */
export async function memberProblems(workspaceId: string, spaceId: string): Promise<string[]> {
  const log = (await q<{ row_key: string; new_value: string | null }>(
    `SELECT row_key, new_value FROM structure_log
      WHERE workspace_id = $1 AND table_name = 'space_members' AND row_key LIKE $2 AND field = 'permission' ORDER BY id`, [workspaceId, `${spaceId}/%`])).rows;
  const replayed = new Map<string, string>();
  for (const r of log) { if (r.new_value === null) replayed.delete(r.row_key); else replayed.set(r.row_key, r.new_value); }
  const actual = new Map((await q<{ k: string; permission: string }>(
    `SELECT space_id::text || '/' || actor_id::text AS k, permission FROM space_members WHERE space_id = $1`, [spaceId])).rows.map((r) => [r.k, r.permission]));
  const [a, b] = [JSON.stringify([...replayed].sort()), JSON.stringify([...actual].sort())];
  return a === b ? [] : [`space ${spaceId}: the structure log replays the members to ${a}, the table holds ${b}`];
}
