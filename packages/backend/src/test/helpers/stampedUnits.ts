// Every unit a stamp trigger writes when a row is made (causal-stamps proposal §4.1), listed by hand: (workspace, stamp table, row key, field).
// Migration 202 finds these in the trigger catalog; the tests that check it ask this list instead, so a unit one of them forgot shows up
// as a difference between the two. A new wired table is added here too. (A board's sections have no unit of their own since migration 209: snapshotTables.ts RETIRED_STAMP_LABELS.)
export const STAMPED_UNITS = `
    SELECT workspace_id AS ws, 'content_nodes' AS tn, id::text AS rk, '*' AS fld FROM content_nodes
    UNION ALL SELECT workspace_id, 'content_nodes.tag_schema', id::text, 'key:' || k FROM content_nodes, jsonb_object_keys(CASE WHEN jsonb_typeof(tag_schema) = 'object' THEN tag_schema ELSE '{}'::jsonb END) k
    UNION ALL SELECT workspace_id, 'content_nodes.collection_views', id::text, 'view:' || (e->>'id') FROM content_nodes, jsonb_array_elements(CASE WHEN jsonb_typeof(collection_views) = 'array' THEN collection_views ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e->'id') = 'string'
    UNION ALL SELECT (SELECT workspace_id FROM content_nodes n WHERE n.id = nt.node_id), 'node_tags', node_id::text || '/' || tag_id::text, '*' FROM node_tags nt
    UNION ALL SELECT workspace_id, 'node_attributes', node_id::text || '/' || key, '*' FROM node_attributes WHERE source IN ('ui', 'explicit', 'dispatcher')
    UNION ALL SELECT workspace_id, 'node_edges', source_node_id::text || '/' || target_node_id::text || '/' || edge_type, '*' FROM node_edges WHERE origin = 'manual'
    UNION ALL SELECT workspace_id, 'note_pointers', id::text, '*' FROM note_pointers
    UNION ALL SELECT workspace_id, 'node_positions', node_id::text || '/' || surface, '*' FROM node_positions
    UNION ALL SELECT workspace_id, 'spaces', id::text, '*' FROM spaces
    UNION ALL SELECT workspace_id, 'spaces.capabilities', id::text, 'switch:' || k FROM spaces, jsonb_object_keys(capabilities) k
    UNION ALL SELECT (SELECT workspace_id FROM spaces s WHERE s.id = m.space_id), 'space_members', space_id::text || '/' || actor_id::text, '*' FROM space_members m
    UNION ALL SELECT id, 'workspaces', id::text, '*' FROM workspaces
    UNION ALL SELECT id, 'workspaces.modules_off', id::text, 'off:' || (e #>> '{}') FROM workspaces, jsonb_array_elements(modules_off) e WHERE jsonb_typeof(e) = 'string'
    UNION ALL SELECT id, 'workspaces.modules_confirmed', id::text, 'confirmed:' || (e #>> '{}') FROM workspaces, jsonb_array_elements(COALESCE(modules_confirmed, '[]'::jsonb)) e WHERE jsonb_typeof(e) = 'string'
    UNION ALL SELECT workspace_id, 'function_refs', id::text, '*' FROM function_refs
    UNION ALL SELECT workspace_id, 'function_refs.config', id::text, 'key:' || k FROM function_refs, jsonb_object_keys(config) k
    UNION ALL SELECT workspace_id, 'rss_mutes', id::text, '*' FROM rss_mutes
    UNION ALL SELECT workspace_id, 'rss_subscriptions', id::text, '*' FROM rss_subscriptions
    UNION ALL SELECT workspace_id, 'external_calendars', id::text, '*' FROM external_calendars
    UNION ALL SELECT (SELECT workspace_id FROM content_nodes n WHERE n.id = s.tag_id), 'actor_module_settings', actor_id::text || '/' || tag_id::text, '*' FROM actor_module_settings s`;
