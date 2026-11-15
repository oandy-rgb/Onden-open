import { describe, it, expect } from "vitest";
import { coreTableWritten } from "../coreWriteSql.js";

describe("coreTableWritten", () => {
  it.each([
    ["INSERT INTO content_nodes (id) VALUES ($1)", "content_nodes"],
    ["insert   into\n  node_tags(a,b) values (1,2)", "node_tags"],
    ["UPDATE node_attributes SET value = $1 WHERE id = $2", "node_attributes"],
    ["update public.node_edges set x = 1", "node_edges"],
    ['DELETE FROM "block_nodes" WHERE id = $1', "block_nodes"],
    ['DELETE FROM "public"."content_nodes" WHERE id = $1', "content_nodes"],
    ["UPDATE ONLY content_nodes SET a = 1", "content_nodes"],
    ["WITH x AS (SELECT 1) INSERT INTO node_edges SELECT * FROM x", "node_edges"],
    ["WITH d AS (DELETE FROM node_tags WHERE a = 1 RETURNING *) SELECT * FROM d", "node_tags"],
    ["INSERT INTO node_attributes (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 2", "node_attributes"],
    ["MERGE INTO content_nodes USING t ON true WHEN MATCHED THEN DELETE", "content_nodes"],
    ["TRUNCATE TABLE node_tags", "node_tags"],
    ["/* note */ UPDATE content_nodes SET a = 1", "content_nodes"],
    ["INSERT INTO block_node_tags (block_node_id) VALUES (1)", "block_node_tags"],
    ["DELETE FROM note_pointers WHERE id = $1", "note_pointers"],
    ["INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')", "space_members"],
    ["UPDATE spaces SET capabilities = $2 WHERE id = $1", "spaces"],
    ["UPDATE workspaces SET modules_off = $2::jsonb WHERE id = $1", "workspaces"],
    ["INSERT INTO node_positions (node_id) VALUES (1) ON CONFLICT (node_id, surface) DO UPDATE SET x = 2", "node_positions"],
  ])("flags %s", (sql, table) => {
    expect(coreTableWritten(sql)).toBe(table);
  });

  it.each([
    "SELECT * FROM content_nodes WHERE id = $1",
    "SELECT * FROM content_nodes FOR UPDATE",
    "SELECT * FROM content_nodes n JOIN node_tags t ON t.node_id = n.id FOR UPDATE OF n",
    "INSERT INTO content_nodes_history (id) VALUES (1)",
    "UPDATE node_tags_archive SET a = 1",
    "DELETE FROM my_node_edges WHERE a = 1",
    "INSERT INTO domain_event (a) VALUES (1)",
    "UPDATE workspace SET a = 1",
    "SELECT 1 -- UPDATE content_nodes SET a = 1",
    "SELECT 'INSERT INTO content_nodes' AS t",
    "/* DELETE FROM node_tags */ SELECT 1",
    "CREATE TABLE content_nodes_x (id int)",
    "UPDATE note_pointers_archive SET a = 1",
    "SELECT * FROM spaces WHERE id = $1",
    "SELECT * FROM node_positions FOR UPDATE",
  ])("ignores %s", (sql) => {
    expect(coreTableWritten(sql)).toBeNull();
  });
});
