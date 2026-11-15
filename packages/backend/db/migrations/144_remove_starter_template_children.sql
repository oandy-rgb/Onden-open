-- 144: starter packs stop stamping empty child notes; clear the ones already stamped.
--
-- Until now the 書籍 / 人物 / 會議 / 專案 starter packs carried `template_children`,
-- so applying such a tag to a note spawned empty English child notes under it
-- (Summary / Highlights / Quotes / Critique for the book pack, and so on). The
-- product decision is that a note only fills in field values and structure
-- lives on the tag's page; the packs no longer ship template_children. The
-- mechanism itself (tag_schema.template_children, services/templateExpander.ts)
-- stays for a future, visible "template" feature. This migration cleans up what
-- the old packs left behind, and only that:
--
-- 1. A child note goes to the trash only when ALL of these hold, so anything
--    that was ever used, edited or linked stays:
--      * it was spawned by a starter pack: its NODE_CREATED event says
--        spawned_by {tag_id, parent_id, slot_index}, its `_tpl_origin` marker
--        is "<parent>:<tag slug>:<slot>", and its title is exactly that slot's
--        title in one of the four starter packs (the tag's template_children
--        are still that pack's list, bodies empty — a tag whose template the
--        user changed is not touched);
--      * it is still live, under the parent it was spawned for, and the parent
--        is live and still carries that tag;
--      * its markdown is empty, it has no child (trashed ones count), no tag,
--        no link, no pointer, no whiteboard card, and is not a workspace home;
--      * its history is only its own creation: the NODE_CREATED event and the
--        ATTRIBUTE_SET events that creation caused (the marker, `child:`
--        prefix attributes). Any other event aimed at it (a title or body
--        edit, a move, a tag, a later attribute change) keeps it. Its current
--        attributes must be exactly those creation events' values. If the
--        creation event is missing, nothing proves it was never edited, so it
--        stays. (Version snapshots no longer exist — migration 053; the event
--        log is the edit history.)
--    The trash is the soft delete a user's delete does: a NODE_DELETED event
--    (actor system 'migration:144', inverse_op node.undeleted) and deleted_at /
--    deleted_by_event_id, so open devices see it with their next sync and any
--    of them can be restored from the history or the trash. Nothing is hard
--    deleted.
--
-- 2. A tag whose template_children are exactly a starter pack's (same titles in
--    order, empty bodies, no child tag) gets `template_children` set to [], with
--    a TAG_SCHEMA_UPDATED event holding the previous list (restorable from the
--    history). Otherwise the next note given the tag would grow the same empty
--    children again. A tag whose list differs in any way is left as it is.
--
-- Idempotent: after the first run no child or tag matches.
--
-- drill: allows notes_live, notes_deleted

DO $remove$
DECLARE
  packs constant jsonb := '[
    ["Summary", "Highlights", "Quotes", "Critique"],
    ["Conversations", "Things to remember", "Important dates"],
    ["Agenda", "Decisions", "Action items"],
    ["Tasks", "Decisions", "Meeting notes", "Retrospective"]
  ]';
  r record;
  ev bigint;
BEGIN
  FOR r IN
    SELECT c.id, c.workspace_id, c.title
      FROM content_nodes c
      JOIN domain_events created
        ON created.workspace_id = c.workspace_id AND created.target_type = 'node'
       AND created.target_id = c.id::text AND created.event_type = 'NODE_CREATED'
       AND created.payload->'spawned_by'->>'parent_id' = c.parent_id::text
      JOIN content_nodes tag
        ON tag.workspace_id = c.workspace_id AND tag.id::text = created.payload->'spawned_by'->>'tag_id'
       AND tag.node_type = 'class_tag' AND tag.deleted_at IS NULL
      JOIN content_nodes parent ON parent.id = c.parent_id AND parent.deleted_at IS NULL
      JOIN node_attributes origin ON origin.node_id = c.id AND origin.key = '_tpl_origin'
     WHERE c.node_type = 'content' AND c.deleted_at IS NULL
       AND c.markdown = ''
       -- The slot named by the marker, in a pack the tag still has verbatim.
       AND origin.value = c.parent_id::text || ':' || (tag.tag_schema->>'slug') || ':'
                          || (created.payload->'spawned_by'->>'slot_index')
       AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(packs) AS pack
              WHERE pack->>((created.payload->'spawned_by'->>'slot_index')::int) = c.title
                AND ARRAY(SELECT e->>'title' FROM jsonb_array_elements(tag.tag_schema->'template_children') e)
                    = ARRAY(SELECT jsonb_array_elements_text(pack))
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tag.tag_schema->'template_children') e
                                 WHERE COALESCE(e->>'body', '') <> '' OR e ? 'child_class_tag_slug'))
       AND EXISTS (SELECT 1 FROM node_tags pt WHERE pt.node_id = c.parent_id AND pt.tag_id = tag.id)
       -- Nothing hangs off it.
       AND NOT EXISTS (SELECT 1 FROM content_nodes ch WHERE ch.parent_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM node_tags t WHERE t.node_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM node_edges e WHERE e.source_node_id = c.id OR e.target_node_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM note_pointers np WHERE np.parent_id = c.id OR np.target_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM node_positions p WHERE p.node_id = c.id OR p.sub_canvas_id = c.id OR p.surface = c.id::text)
       AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.home_node_id = c.id)
       -- Its history is its creation and what creation caused.
       AND NOT EXISTS (
             SELECT 1 FROM domain_events e
              WHERE e.workspace_id = c.workspace_id AND e.target_id = c.id::text
                AND e.id <> created.id
                AND NOT (e.event_type = 'ATTRIBUTE_SET' AND e.triggered_by_event_id = created.id))
       -- Every attribute is one of those creation events' values, unchanged.
       AND NOT EXISTS (
             SELECT 1 FROM node_attributes a
              WHERE a.node_id = c.id
                AND NOT EXISTS (
                      SELECT 1 FROM domain_events e
                       WHERE e.workspace_id = c.workspace_id AND e.target_id = c.id::text
                         AND e.event_type = 'ATTRIBUTE_SET' AND e.triggered_by_event_id = created.id
                         AND e.payload->>'key' = a.key AND e.payload->>'value' = a.value))
     ORDER BY c.id
       FOR UPDATE OF c
  LOOP
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:144', 'NODE_DELETED', 'node', r.id::text,
            jsonb_build_object('title', r.title),
            jsonb_build_object('inverse_op', 'node.undeleted', 'ui_context', 'migration.remove_starter_template_children'))
    RETURNING id INTO ev;
    UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = ev, updated_at = now() WHERE id = r.id;
  END LOOP;

  FOR r IN
    SELECT t.id, t.workspace_id, t.tag_schema->'template_children' AS previous
      FROM content_nodes t
     WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL
       AND jsonb_typeof(t.tag_schema->'template_children') = 'array'
       AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(packs) AS pack
              WHERE ARRAY(SELECT e->>'title' FROM jsonb_array_elements(t.tag_schema->'template_children') e)
                    = ARRAY(SELECT jsonb_array_elements_text(pack)))
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.tag_schema->'template_children') e
                        WHERE COALESCE(e->>'body', '') <> '' OR e ? 'child_class_tag_slug')
     ORDER BY t.id
       FOR UPDATE OF t
  LOOP
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:144', 'TAG_SCHEMA_UPDATED', 'tag', r.id::text,
            jsonb_build_object('changed', jsonb_build_array('template_children'),
                               'next_field_values', jsonb_build_object('template_children', '[]'::jsonb),
                               'created', false),
            jsonb_build_object('inverse_op', 'tag_schema.updated',
                               'prev_field_values', jsonb_build_object('template_children', r.previous),
                               'ui_context', 'migration.remove_starter_template_children'));
    UPDATE content_nodes
       SET tag_schema = tag_schema || jsonb_build_object('template_children', '[]'::jsonb), updated_at = now()
     WHERE id = r.id;
  END LOOP;
END
$remove$;
