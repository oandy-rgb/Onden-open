CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgroonga;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('manual', 'rss', 'ai')),
  node_type text NOT NULL CHECK (node_type IN ('content', 'candidate', 'page')),
  title text NOT NULL,
  slug text NOT NULL,
  markdown text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('candidate', 'draft', 'reviewed', 'published', 'archived', 'rejected')),
  x integer NOT NULL DEFAULT 0,
  y integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  target_node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  edge_type text NOT NULL CHECK (edge_type IN ('knowledge_link', 'suggested_link', 'nav_link')),
  status text NOT NULL CHECK (status IN ('active', 'suggested', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE node_edges ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';
CREATE UNIQUE INDEX IF NOT EXISTS node_edges_unique_origin_idx
  ON node_edges (workspace_id, source_node_id, target_node_id, edge_type, origin);

CREATE TABLE IF NOT EXISTS node_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('todo', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rss_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rss_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rss_source_id uuid REFERENCES rss_sources(id) ON DELETE SET NULL,
  title text NOT NULL,
  url text NOT NULL,
  summary text NOT NULL DEFAULT '',
  raw_content text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('imported', 'converted', 'rejected')),
  node_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('node', 'edge', 'rss_item')),
  target_id uuid NOT NULL,
  suggestion_type text NOT NULL CHECK (suggestion_type IN ('summary', 'tags', 'edge')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'ai_agent', 'system')),
  actor_id text NOT NULL,
  event_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION domain_events_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'domain_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_events_no_update ON domain_events;
CREATE TRIGGER domain_events_no_update
  BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION domain_events_immutable();

CREATE TABLE IF NOT EXISTS publish_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  home_node_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL,
  event_cursor bigint NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS git_commit text;
ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL;

DO $$
BEGIN
  BEGIN ALTER TABLE content_nodes DROP CONSTRAINT content_nodes_node_type_check;
  EXCEPTION WHEN undefined_object THEN NULL; END;
  BEGIN ALTER TABLE content_nodes ADD CONSTRAINT content_nodes_node_type_check
    CHECK (node_type IN ('content', 'candidate', 'page', 'group'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

-- Migrate candidate/page node_types and candidate status
UPDATE content_nodes SET node_type = 'content', hidden = true WHERE node_type = 'candidate';
UPDATE content_nodes SET node_type = 'content' WHERE node_type = 'page';
UPDATE content_nodes SET status = 'draft' WHERE status = 'candidate';

DO $$
BEGIN
  BEGIN ALTER TABLE content_nodes DROP CONSTRAINT content_nodes_node_type_check;
  EXCEPTION WHEN undefined_object THEN NULL; END;
  BEGIN ALTER TABLE content_nodes ADD CONSTRAINT content_nodes_node_type_check
    CHECK (node_type IN ('content', 'group'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

DO $$
BEGIN
  BEGIN ALTER TABLE content_nodes DROP CONSTRAINT content_nodes_status_check;
  EXCEPTION WHEN undefined_object THEN NULL; END;
  BEGIN ALTER TABLE content_nodes ADD CONSTRAINT content_nodes_status_check
    CHECK (status IN ('pending', 'draft', 'reviewed', 'published', 'archived', 'rejected'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS home_node_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL;

INSERT INTO workspaces (name, slug)
VALUES ('Onden MVP', 'default')
ON CONFLICT (slug) DO NOTHING;

-- Node version history (Level 1 rollback)
CREATE TABLE IF NOT EXISTS content_node_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  markdown text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_node_versions_node_id_idx
  ON content_node_versions (node_id, changed_at DESC);

CREATE OR REPLACE FUNCTION capture_node_version()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.markdown <> NEW.markdown OR OLD.title <> NEW.title THEN
    INSERT INTO content_node_versions (node_id, workspace_id, title, markdown)
    VALUES (OLD.id, OLD.workspace_id, OLD.title, OLD.markdown);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS node_version_capture ON content_nodes;
CREATE TRIGGER node_version_capture
  BEFORE UPDATE ON content_nodes
  FOR EACH ROW EXECUTE FUNCTION capture_node_version();

-- Canvas whiteboards (Obsidian Canvas / Heptabase style)
CREATE TABLE IF NOT EXISTS canvases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled Canvas',
  data jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canvases_workspace_id_idx ON canvases (workspace_id, updated_at DESC);

-- PGroonga full-text search index on title + markdown
CREATE INDEX IF NOT EXISTS content_nodes_pgroonga_idx
  ON content_nodes
  USING pgroonga (title, markdown);

-- Per-page Puck block layout (stored as Puck Data JSON)
ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS presentation jsonb;

-- ── Actors: humans + AI agents as first-class principals ──
CREATE TABLE IF NOT EXISTS actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('human', 'agent')),
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor', 'reviewer', 'admin')),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_id)
);

-- Seed system actor per workspace
INSERT INTO actors (workspace_id, name, type, role, external_id)
SELECT id, 'System', 'agent', 'admin', 'system'
FROM workspaces
ON CONFLICT (workspace_id, external_id) DO NOTHING;

-- ── Tags: content labels with merge thresholds ──
CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#888888',
  merge_threshold int NOT NULL DEFAULT 0 CHECK (merge_threshold >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- ── Node ↔ Tag many-to-many ──
CREATE TABLE IF NOT EXISTS node_tags (
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, tag_id)
);

CREATE INDEX IF NOT EXISTS node_tags_tag_id_idx ON node_tags (tag_id);

-- ── Role → visible tags ──
CREATE TABLE IF NOT EXISTS role_visible_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role text NOT NULL,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, role, tag_id)
);

-- ── Extend content_node_versions with CoW sandbox fields ──
ALTER TABLE content_node_versions
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS merge_threshold int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES actors(id) ON DELETE SET NULL;

-- Partial index: fast inbox query (pending versions only)
CREATE INDEX IF NOT EXISTS content_node_versions_pending_idx
  ON content_node_versions (workspace_id, changed_at DESC)
  WHERE is_pending = true;

-- ── Workspace-level default agent threshold (fallback when node has no tags) ──
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS default_agent_threshold int NOT NULL DEFAULT 0;

-- ── Actor isolation level + agent subtype ──
ALTER TABLE actors
  ADD COLUMN IF NOT EXISTS isolation_level int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agent_subtype text CHECK (agent_subtype IN ('deterministic', 'llm', 'admin'));

-- Set sensible defaults by type (run once after column exists)
UPDATE actors SET isolation_level = 0 WHERE type = 'human';
UPDATE actors SET isolation_level = 0, agent_subtype = 'admin' WHERE external_id = 'system';

-- ── RLS: only admin role can delete node_tags (enforced after auth is wired) ──
ALTER TABLE node_tags ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY node_tags_select ON node_tags FOR SELECT USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY node_tags_insert ON node_tags FOR INSERT WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY node_tags_delete ON node_tags FOR DELETE USING (
    current_setting('app.actor_role', true) = 'admin'
    OR current_setting('app.actor_role', true) IS NULL
    OR current_setting('app.actor_role', true) = ''
  );
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Sandbox drafts (one per workspace+actor) ──
CREATE TABLE IF NOT EXISTS sandbox_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  content text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, actor_id)
);

-- ── Tag kind: 'content' (metadata) vs 'role' (ACL boundary) ──
ALTER TABLE tags ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'content'
  CHECK (kind IN ('content', 'role'));

-- role tags are auto-created when a role is needed as ACL boundary
-- role_visible_tags already exists and maps role → visible tag_ids

-- ── Shared sandbox (one active session per workspace) ──
CREATE TABLE IF NOT EXISTS sandboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  allowed_roles text[] NOT NULL DEFAULT ARRAY['editor','reviewer','admin'],
  created_by uuid REFERENCES actors(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id)
);
ALTER TABLE sandboxes DROP COLUMN IF EXISTS content;

CREATE TABLE IF NOT EXISTS sandbox_participants (
  sandbox_id uuid NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  actor_name text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sandbox_id, actor_id)
);

-- ── Sandbox staged nodes (CoW per-node drafts) ──
CREATE TABLE IF NOT EXISTS sandbox_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_id uuid NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  source_node_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL,
  draft_title text NOT NULL DEFAULT '',
  draft_content text NOT NULL DEFAULT '',
  added_by uuid REFERENCES actors(id) ON DELETE SET NULL,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── AI suggestion reasoning (why the AI made this suggestion) ──
ALTER TABLE ai_suggestions ADD COLUMN IF NOT EXISTS reasoning text;

-- ── Site pages (website page entities, separate from content nodes) ──
CREATE TABLE IF NOT EXISTS site_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  slug text NOT NULL DEFAULT '',
  layout text NOT NULL DEFAULT 'full' CHECK (layout IN ('full', 'sidebar-left', 'sidebar-right')),
  sidebar_ratio numeric(4,3) NOT NULL DEFAULT 0.25,
  blocks jsonb NOT NULL DEFAULT '[]',
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── CoW: add 'pending' status (sandbox & agent submissions start here) ──
DO $$
BEGIN
  BEGIN ALTER TABLE content_nodes DROP CONSTRAINT content_nodes_status_check;
  EXCEPTION WHEN undefined_object THEN NULL; END;
  BEGIN ALTER TABLE content_nodes ADD CONSTRAINT content_nodes_status_check
    CHECK (status IN ('pending', 'draft', 'reviewed', 'published', 'archived', 'rejected'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- ── Unify node types: any node can have children, no more 'group' type ──
UPDATE content_nodes SET node_type = 'content' WHERE node_type = 'group';
DO $$
BEGIN
  BEGIN ALTER TABLE content_nodes DROP CONSTRAINT content_nodes_node_type_check;
  EXCEPTION WHEN undefined_object THEN NULL; END;
  BEGIN ALTER TABLE content_nodes ADD CONSTRAINT content_nodes_node_type_check
    CHECK (node_type IN ('content'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

