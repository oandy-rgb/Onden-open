-- M3.1 — collection_views: saved view configs per class tag.
--
-- A View IS a saved query + rendering config. Same pattern Tana/AppFlowy/
-- SiYuan converge on (per memory/project_feature_view_layouts):
--
--   View {
--     filters[], sorts[], group_by      // layout-orthogonal
--     layout: "table"|"list"|"kanban"   // rendering only
--     visible_fields[]
--     layout_config jsonb                // per-layout extras
--   }
--
-- Filter/sort/group operate on data BEFORE layout sees it. Switching
-- layout doesn't re-query, just re-renders.
--
-- Onden scope (M3 MVP):
--   - layouts: "list" + "table" only. Kanban/Calendar/Gallery deferred.
--   - filter ops: eq, ne, contains, empty, nempty (5 ops).
--   - sorts: built-in (title/updated_at) + attribute key.
--
-- References:
--   - SiYuan av/layout_table.go / layout_kanban.go (rendering structs)
--   - SiYuan av/filter.go (14 ops; Onden ships 5 first)
--   - AppFlowy plugins/database/{grid,board,calendar}/ (per-layout subdirs)
--
-- Restorable: every CREATE/UPDATE/DELETE goes through emit() + dispatcher,
-- so the ER series + Trash view automatically cover views too.

CREATE TABLE collection_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The class tag whose instances this view renders. ON DELETE CASCADE
  -- so deleting a class tag also cleans up its views; the donor row in
  -- domain_events still preserves provenance.
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  name            text NOT NULL,
  layout          text NOT NULL CHECK (layout IN ('list', 'table', 'kanban', 'calendar', 'gallery')),
  -- Layout-orthogonal query config (jsonb so we don't migrate every time
  -- filter ops grow).
  filters         jsonb NOT NULL DEFAULT '[]'::jsonb,
  sorts           jsonb NOT NULL DEFAULT '[]'::jsonb,
  group_by        text,
  visible_fields  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Per-layout rendering config (column widths, kanban group key, etc).
  layout_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Pin order: lower = earlier in the view chip strip. Default 0 keeps
  -- views in (workspace, tag, name) order until the user re-pins.
  pin_order       int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collection_views_tag_idx ON collection_views (workspace_id, tag_id, pin_order);
CREATE UNIQUE INDEX collection_views_tag_name_uq ON collection_views (workspace_id, tag_id, name);

COMMENT ON TABLE collection_views IS
  'M3.1: saved view configs per class tag. A View = filters + sorts + group_by + layout. Reference: SiYuan av/, AppFlowy plugins/database/, Tana supertag views.';
