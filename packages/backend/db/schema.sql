-- ============================================================================
-- GENERATED FILE — do not hand-edit.
--
-- Regenerate after adding migrations:
--   docker exec onden-postgres-1 pg_dump -U onden --schema-only --no-owner \
--     --no-privileges --exclude-table=public.account --exclude-table=public.session \
--     --exclude-table=public.user --exclude-table=public.verification onden_test
--   + re-seed schema_migrations with every db/migrations/*.sql version.
--
-- This is the CURRENT schema snapshot. The schema_migrations rows at the bottom
-- are pre-seeded so a fresh `compose up` (initdb loads this) → backend migrate()
-- is a NO-OP rather than re-applying everything on top. Existing DBs are
-- unaffected: migrate() still applies any NEWER migration incrementally.
-- (better-auth's user/session/account/verification tables are excluded — its
-- own runMigrations() creates them at boot.)
-- ============================================================================
--
-- PostgreSQL database dump
--

\restrict tXERIUh6s2kZD5Wm0LJCJYcsdQ3jZxug0nz7tPWbmzSNCf6Q9s01dRDFkRJbyH5

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg12+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: pgroonga; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA public;


--
-- Name: EXTENSION pgroonga; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgroonga IS 'Super fast and all languages supported full text search index based on Groonga';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: actor_ref_resolves(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.actor_ref_resolves(ws uuid, ref text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $_$
  SELECT CASE
    WHEN ref IS NULL THEN true
    WHEN ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.actors a WHERE a.id = ref::uuid AND a.workspace_id = ws
    )
  END;
$_$;


--
-- Name: assert_actor_ref(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_actor_ref() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  col text := TG_ARGV[0];
  ref text := (to_jsonb(NEW) ->> col);
  ws  uuid := (to_jsonb(NEW) ->> 'workspace_id')::uuid;
BEGIN
  IF NOT public.actor_ref_resolves(ws, ref) THEN
    RAISE EXCEPTION
      '%.% = % is uuid-shaped but resolves to no actor in workspace %',
      TG_TABLE_NAME, col, ref, ws
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: domain_events_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.domain_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- 118: the one allowed update — a permanent delete erasing an event's
  -- content to the fixed marker, in a transaction that opted in.
  IF current_setting('myapp.allow_event_redact', true) = 'on'
     AND NEW.payload = '{"purged": true}'::jsonb
     AND NEW.tx_meta = '{"purged": true}'::jsonb
     AND NEW.id = OLD.id
     AND NEW.workspace_id = OLD.workspace_id
     AND NEW.actor_type = OLD.actor_type
     AND NEW.actor_id = OLD.actor_id
     AND NEW.event_type = OLD.event_type
     AND NEW.target_type = OLD.target_type
     AND NEW.target_id = OLD.target_id
     AND NEW.created_at = OLD.created_at
     AND NEW.triggered_by_event_id IS NOT DISTINCT FROM OLD.triggered_by_event_id
     AND NEW.external = OLD.external THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'domain_events is append-only';
END;
$$;


--
-- Name: domain_events_prevent_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.domain_events_prevent_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Invariant 1: an event that carries content (body_hash -> blobs) is immortal.
  IF OLD.payload ? 'body_hash' THEN
    RAISE EXCEPTION
      'domain_events is append-only: event % carries content (body_hash) and can never be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Invariant 2: deletion only via the sanctioned, opt-in retention path.
  IF current_setting('myapp.allow_event_prune', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'domain_events is append-only: deletion is only permitted via the sanctioned retention path'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;


--
-- Name: note_link_index_new_note(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.note_link_index_new_note() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO public.note_link_index (note_id, workspace_id) VALUES (NEW.id, NEW.workspace_id)
  ON CONFLICT (note_id) DO NOTHING;
  RETURN NULL;
END;
$$;


--
-- Name: note_link_index_text_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.note_link_index_text_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE public.note_link_index SET stale = true WHERE note_id = NEW.id AND NOT stale;
  RETURN NULL;
END;
$$;


--
-- Name: track_node_tag_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_node_tag_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Key-changing UPDATEs are equivalent to removing the old pair and applying
  -- the new one. Timestamp-only updates do not change membership identity.
  IF TG_OP = 'UPDATE' AND NEW.node_id = OLD.node_id AND NEW.tag_id = OLD.tag_id THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    -- A hard purge cascades through both tables. Do not recreate state for a
    -- parent that has already gone (FK cascade trigger ordering is not a contract).
    IF EXISTS (SELECT 1 FROM public.content_nodes WHERE id = OLD.node_id)
       AND EXISTS (SELECT 1 FROM public.content_nodes WHERE id = OLD.tag_id) THEN
      INSERT INTO public.node_tag_states (node_id, tag_id, is_applied, state_id)
      VALUES (OLD.node_id, OLD.tag_id, false, gen_random_uuid())
      ON CONFLICT (node_id, tag_id) DO UPDATE
        SET is_applied = false, previous_state_id = node_tag_states.state_id,
            state_id = EXCLUDED.state_id;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO public.node_tag_states (node_id, tag_id, is_applied, state_id)
    VALUES (NEW.node_id, NEW.tag_id, true, gen_random_uuid())
    ON CONFLICT (node_id, tag_id) DO UPDATE
      SET is_applied = true, previous_state_id = node_tag_states.state_id,
          state_id = EXCLUDED.state_id;
  END IF;
  RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: actors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.actors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    external_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scoped_tag_ids uuid[],
    CONSTRAINT actors_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'reviewer'::text, 'admin'::text]))),
    CONSTRAINT actors_type_check CHECK ((type = ANY (ARRAY['human'::text, 'agent'::text])))
);


--
-- Name: agent_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    token_hash text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    allowed_tools text[],
    allowed_tag_ids uuid[],
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: ai_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    suggestion_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reasoning text,
    CONSTRAINT ai_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT ai_suggestions_suggestion_type_check CHECK ((suggestion_type = ANY (ARRAY['summary'::text, 'tags'::text, 'edge'::text]))),
    CONSTRAINT ai_suggestions_target_type_check CHECK ((target_type = ANY (ARRAY['node'::text, 'edge'::text])))
);


--
-- Name: blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blobs (
    hash text NOT NULL,
    content text NOT NULL,
    size_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: content_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    node_type text NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    markdown text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_id uuid,
    hidden boolean DEFAULT false NOT NULL,
    sort_order integer,
    order_key text COLLATE "C" DEFAULT 'a0'::text NOT NULL,
    order_stamp text COLLATE "C" DEFAULT ''::text NOT NULL,
    presentation jsonb,
    deleted_at timestamp with time zone,
    deleted_by_event_id bigint,
    tag_color text,
    tag_schema jsonb,
    collection_views jsonb,
    reserved_key text,
    CONSTRAINT content_nodes_node_type_check CHECK ((node_type = ANY (ARRAY['content'::text, 'class_tag'::text, 'canvas'::text]))),
    CONSTRAINT content_nodes_source_type_check CHECK ((source_type = ANY (ARRAY['manual'::text, 'rss'::text, 'ai'::text, 'system'::text])))
);


--
-- Name: COLUMN content_nodes.deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_nodes.deleted_at IS 'Soft-delete tombstone. NULL = live; non-NULL = trashed at this time. All FK-CASCADE dependents (versions, attributes, tags, edges, block_ids, pointers, tasks) survive the delete, so undelete is a single UPDATE deleted_at = NULL that brings everything back.';


--
-- Name: COLUMN content_nodes.deleted_by_event_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_nodes.deleted_by_event_id IS 'FK to the NODE_DELETED domain_event that wrote the tombstone. Lets the restore flow find the originating event without timestamp matching.';


--
-- Name: COLUMN content_nodes.tag_color; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_nodes.tag_color IS 'A1 L3-A: hex color for node_type=class_tag rows. NULL for regular content.';




--
-- Name: COLUMN content_nodes.reserved_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_nodes.reserved_key IS 'Role of a system-reserved class_tag (task, workspace-config, page); NULL for ordinary nodes. See services/reservedTags.ts. (subscription retired by migration 114: RSS sources carry _rss_kind instead.)';


--
-- Name: CONSTRAINT content_nodes_node_type_check ON content_nodes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT content_nodes_node_type_check ON public.content_nodes IS 'Allowed kinds. content=regular note (may carry a view definition in its body); class_tag=tag-as-node (migration 037); canvas=spatial surface-as-node (migration 057, the retired canvases table). The 042 addition of base was rolled back — bases are presentational, not a distinct entity.';


--
-- Name: dispatcher_pending; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatcher_pending (
    event_id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    node_id uuid NOT NULL,
    actor_id text NOT NULL,
    token_id text,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: domain_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domain_events (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    event_type text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tx_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    triggered_by_event_id bigint,
    external boolean DEFAULT false NOT NULL,
    body_hash text,
    base_hash text,
    device_id uuid,
    CONSTRAINT domain_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'ai_agent'::text, 'system'::text])))
);


--
-- Name: COLUMN domain_events.tx_meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domain_events.tx_meta IS 'Restore context for this event. Conventional keys: inverse_patch (string, diff-match-patch unified patch for body markdown), prev_field_values (object, {field: prev_value} for small fields), cursor_state (object, {block_id, offset} for editor restore), ui_context (string, which UI surface initiated the event).';


--
-- Name: COLUMN domain_events.triggered_by_event_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domain_events.triggered_by_event_id IS 'Cause event in a dispatcher cascade. Reverting the root with ?cascade walks the tree and reverts children too.';


--
-- Name: COLUMN domain_events.body_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domain_events.body_hash IS 'Note body after this event (sha256 hex of the markdown, not normalised). Same value as payload.body_hash; events before migration 162 have NULL.';


--
-- Name: COLUMN domain_events.base_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domain_events.base_hash IS 'Body this write was made from (the editor''s merge base, else the body it replaced). NULL for a note''s first version and for events before migration 162.';


--
-- Name: COLUMN domain_events.external; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domain_events.external IS 'true when this event has an out-of-PG side effect (FS git commit, GitHub push, external tool call). Restore endpoints MUST NOT attempt to replay inverse for these.';


--
-- Name: domain_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.domain_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: domain_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.domain_events_id_seq OWNED BY public.domain_events.id;


--
-- Name: event_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_reviews (
    event_id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    decision text NOT NULL,
    reviewed_by text NOT NULL,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    restore_event_id bigint,
    note text,
    CONSTRAINT event_reviews_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text])))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    key uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: imported_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imported_media (
    workspace_id uuid NOT NULL,
    actor_id text NOT NULL,
    content_hash text NOT NULL,
    extension text NOT NULL,
    filename text NOT NULL,
    CONSTRAINT imported_media_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT imported_media_extension_check CHECK ((extension = ANY (ARRAY['.jpg'::text, '.jpeg'::text, '.png'::text, '.gif'::text, '.webp'::text, '.avif'::text, '.svg'::text, '.ico'::text, '.pdf'::text, '.docx'::text, '.xlsx'::text, '.pptx'::text, '.eml'::text, '.txt'::text, '.mp3'::text, '.m4a'::text, '.wav'::text, '.oga'::text, '.ogg'::text, '.aac'::text, '.flac'::text, '.mp4'::text, '.webm'::text, '.mov'::text, '.ogv'::text]))),
    CONSTRAINT imported_media_filename_check CHECK ((filename ~ '^[0-9a-f]{32}\.[a-z0-9]+$'::text))
);


--
-- Name: member_removals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_removals (
    workspace_id uuid NOT NULL,
    external_id text NOT NULL,
    removed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: node_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_attributes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    node_id uuid NOT NULL,
    key text NOT NULL,
    value text DEFAULT ''::text NOT NULL,
    is_inheritable boolean DEFAULT false NOT NULL,
    value_type text DEFAULT 'text'::text NOT NULL,
    source text DEFAULT 'explicit'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT node_attributes_source_check CHECK ((source = ANY (ARRAY['ui'::text, 'markdown'::text, 'frontmatter'::text, 'dispatcher'::text, 'explicit'::text, 'derived'::text]))),
    CONSTRAINT node_attributes_value_type_check CHECK ((value_type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'bool'::text, 'node_ref'::text])))
);


--
-- Name: block_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    note_id uuid NOT NULL,
    block_ref text NOT NULL,
    parent_block_id uuid,
    kind text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    text_cache text DEFAULT ''::text NOT NULL,
    hidden_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT block_nodes_kind_chk CHECK ((kind = ANY (ARRAY['paragraph'::text, 'listItem'::text, 'heading'::text, 'quote'::text]))),
    CONSTRAINT block_nodes_ref_chk CHECK (((block_ref ~ '^[a-zA-Z0-9-]+$'::text) AND (length(block_ref) <= 64)))
);


--
-- Name: block_node_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_node_tags (
    block_node_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: note_block_refs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_block_refs (
    workspace_id uuid NOT NULL,
    note_id uuid NOT NULL,
    block_ref text NOT NULL,
    PRIMARY KEY (note_id, block_ref),
    CONSTRAINT note_block_refs_ref_chk CHECK (block_ref ~ '^[a-zA-Z0-9-]+$' AND length(block_ref) <= 64)
);


--
-- Name: note_link_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_link_index (
    note_id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    link_lc text[] DEFAULT '{}'::text[] NOT NULL,
    link_slug text[] DEFAULT '{}'::text[] NOT NULL,
    stale boolean DEFAULT true NOT NULL
);


--
-- Name: board_copy_folds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.board_copy_folds (
    node_id uuid NOT NULL,
    folded_into uuid NOT NULL,
    workspace_id uuid NOT NULL,
    b_cards jsonb NOT NULL,
    moved_card_ids text[] NOT NULL,
    dropped_cards jsonb NOT NULL,
    moved_sections_id uuid,
    added_view_id text,
    prev_view jsonb,
    prev_collection_views jsonb,
    delete_event_id bigint NOT NULL,
    folded_at timestamp with time zone DEFAULT now() NOT NULL,
    restored_at timestamp with time zone
);


--
-- Name: TABLE board_copy_folds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.board_copy_folds IS 'Whiteboard copies (boards made from sub-notes) folded back into the original note by migration 139. Kept so the fold can be undone (scripts/restoreFoldedBoards.sql).';


--
-- Name: board_copy_unparents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.board_copy_unparents (
    node_id uuid NOT NULL,
    copy_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    prev_parent_id uuid NOT NULL,
    prev_sort_order integer NOT NULL,
    event_id bigint NOT NULL,
    unparented_at timestamp with time zone DEFAULT now() NOT NULL,
    restored_at timestamp with time zone
);


--
-- Name: TABLE board_copy_unparents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.board_copy_unparents IS 'Notes migration 141 moved out from under their whiteboard copy before folding it (board_copy_folds). Kept so restoreFoldedBoards.sql can put them back.';


--
-- Name: canvas_note_conversions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_note_conversions (
    node_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    added_view_id text,
    prev_view jsonb,
    prev_collection_views jsonb,
    converted_at timestamp with time zone DEFAULT now() NOT NULL,
    restored_at timestamp with time zone
);


--
-- Name: TABLE canvas_note_conversions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.canvas_note_conversions IS 'Notes that were node_type canvas before migration 138 turned the whiteboard into a view of a note. Kept so the conversion can be undone (scripts/restoreCanvasNotes.sql).';


--
-- Name: board_ink_moves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.board_ink_moves (
    node_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    suggested text NOT NULL,
    signals jsonb NOT NULL,
    board_ink_attribute_id uuid NOT NULL,
    value_hash text NOT NULL,
    moved_at timestamp with time zone DEFAULT now() NOT NULL,
    decision text,
    decided_at timestamp with time zone,
    restored_at timestamp with time zone,
    CONSTRAINT board_ink_moves_action_check CHECK ((action = ANY (ARRAY['moved'::text, 'copied'::text]))),
    CONSTRAINT board_ink_moves_decision_check CHECK ((decision = ANY (ARRAY['board'::text, 'handwriting'::text]))),
    CONSTRAINT board_ink_moves_reason_check CHECK ((reason = ANY (ARRAY['canvas_note_conversion'::text, 'outside_page'::text, 'ambiguous'::text]))),
    CONSTRAINT board_ink_moves_suggested_check CHECK ((suggested = ANY (ARRAY['board'::text, 'handwriting'::text, 'unknown'::text])))
);


--
-- Name: TABLE board_ink_moves; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.board_ink_moves IS 'Notes whose ink_data held a whiteboard pen layer before migration 172 gave the layer its own attribute board_ink: moved (certain) or copied (ambiguous). Kept so the move can be undone (scripts/restoreBoardInk.sql) and the ambiguous ones decided.';


--
-- Name: node_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    edge_type text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    CONSTRAINT node_edges_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suggested'::text, 'rejected'::text])))
);


--
-- Name: node_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_embeddings (
    node_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    model text NOT NULL,
    content_hash text NOT NULL,
    embedding public.vector(384) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: node_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_positions (
    node_id uuid NOT NULL,
    surface text NOT NULL,
    x double precision NOT NULL,
    y double precision NOT NULL,
    width double precision,
    height double precision,
    color text,
    folded boolean DEFAULT false NOT NULL,
    sub_canvas_id uuid,
    workspace_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: node_tag_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_tag_states (
    node_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    is_applied boolean NOT NULL,
    state_id uuid,
    previous_state_id uuid,
    CONSTRAINT node_tag_states_check CHECK (((NOT is_applied) OR (state_id IS NOT NULL)))
);


--
-- Name: node_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_tags (
    node_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: note_pointers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_pointers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    parent_id uuid,
    target_id uuid NOT NULL,
    sort_order integer,
    order_key text COLLATE "C" DEFAULT 'a0'::text NOT NULL,
    order_stamp text COLLATE "C" DEFAULT ''::text NOT NULL,
    display_prefix text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    effect_kind text NOT NULL,
    dedup_key text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 35 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    triggered_by_event_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    done_at timestamp with time zone
);


--
-- Name: outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbox_id_seq OWNED BY public.outbox.id;


--
-- Name: publish_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publish_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    title text NOT NULL,
    home_node_id uuid,
    event_cursor bigint NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    artifact_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rate_limit_hits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_hits (
    token_id text NOT NULL,
    hit_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rss_staging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rss_staging (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    guid text NOT NULL,
    title text NOT NULL,
    url text,
    published_at timestamp with time zone,
    body text DEFAULT ''::text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    seen_at timestamp with time zone,
    saved_node_id uuid,
    tombstoned_at timestamp with time zone
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    home_node_id uuid,
    membership_epoch bigint DEFAULT 0 NOT NULL,
    modules jsonb,
    modules_off jsonb DEFAULT '[]'::jsonb NOT NULL,
    modules_confirmed jsonb DEFAULT '[]'::jsonb,
    time_zone text,
    day_start_hour smallint DEFAULT 0 NOT NULL,
    CONSTRAINT workspaces_day_start_hour_check CHECK (((day_start_hour >= 0) AND (day_start_hour <= 6)))
);


--
-- Name: domain_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_events ALTER COLUMN id SET DEFAULT nextval('public.domain_events_id_seq'::regclass);


--
-- Name: outbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox ALTER COLUMN id SET DEFAULT nextval('public.outbox_id_seq'::regclass);


--
-- Name: actors actors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_pkey PRIMARY KEY (id);


--
-- Name: actors actors_workspace_id_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_workspace_id_external_id_key UNIQUE (workspace_id, external_id);


--
-- Name: agent_tokens agent_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_pkey PRIMARY KEY (id);


--
-- Name: agent_tokens agent_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: ai_suggestions ai_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_suggestions
    ADD CONSTRAINT ai_suggestions_pkey PRIMARY KEY (id);


--
-- Name: blobs blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (hash);


--
-- Name: content_nodes content_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_nodes
    ADD CONSTRAINT content_nodes_pkey PRIMARY KEY (id);


--
-- Name: dispatcher_pending dispatcher_pending_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatcher_pending
    ADD CONSTRAINT dispatcher_pending_pkey PRIMARY KEY (event_id);


--
-- Name: domain_events domain_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_pkey PRIMARY KEY (id);


--
-- Name: event_reviews event_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_reviews
    ADD CONSTRAINT event_reviews_pkey PRIMARY KEY (event_id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (key);


--
-- Name: imported_media imported_media_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imported_media
    ADD CONSTRAINT imported_media_filename_key UNIQUE (filename);


--
-- Name: imported_media imported_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imported_media
    ADD CONSTRAINT imported_media_pkey PRIMARY KEY (workspace_id, actor_id, content_hash, extension);


--
-- Name: member_removals member_removals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_removals
    ADD CONSTRAINT member_removals_pkey PRIMARY KEY (workspace_id, external_id);


--
-- Name: node_attributes node_attributes_node_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_attributes
    ADD CONSTRAINT node_attributes_node_id_key_key UNIQUE (node_id, key);


--
-- Name: node_attributes node_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_attributes
    ADD CONSTRAINT node_attributes_pkey PRIMARY KEY (id);


--
-- Name: block_nodes block_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_nodes
    ADD CONSTRAINT block_nodes_pkey PRIMARY KEY (id);


--
-- Name: block_nodes block_nodes_note_ref_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_nodes
    ADD CONSTRAINT block_nodes_note_ref_uq UNIQUE (note_id, block_ref);


--
-- Name: block_node_tags block_node_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_node_tags
    ADD CONSTRAINT block_node_tags_pkey PRIMARY KEY (block_node_id, tag_id);


--
-- Name: node_edges node_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_edges
    ADD CONSTRAINT node_edges_pkey PRIMARY KEY (id);


--
-- Name: node_embeddings node_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_embeddings
    ADD CONSTRAINT node_embeddings_pkey PRIMARY KEY (node_id);


--
-- Name: board_copy_folds board_copy_folds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_copy_folds
    ADD CONSTRAINT board_copy_folds_pkey PRIMARY KEY (node_id);


--
-- Name: board_copy_unparents board_copy_unparents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_copy_unparents
    ADD CONSTRAINT board_copy_unparents_pkey PRIMARY KEY (node_id);


--
-- Name: board_ink_moves board_ink_moves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_ink_moves
    ADD CONSTRAINT board_ink_moves_pkey PRIMARY KEY (node_id);


--
-- Name: canvas_note_conversions canvas_note_conversions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_note_conversions
    ADD CONSTRAINT canvas_note_conversions_pkey PRIMARY KEY (node_id);


--
-- Name: node_positions node_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_positions
    ADD CONSTRAINT node_positions_pkey PRIMARY KEY (node_id, surface);


--
-- Name: node_tag_states node_tag_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_tag_states
    ADD CONSTRAINT node_tag_states_pkey PRIMARY KEY (node_id, tag_id);


--
-- Name: node_tags node_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_tags
    ADD CONSTRAINT node_tags_pkey PRIMARY KEY (node_id, tag_id);


--
-- Name: note_pointers note_pointers_parent_id_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_pointers
    ADD CONSTRAINT note_pointers_parent_id_target_id_key UNIQUE (parent_id, target_id);


--
-- Name: note_pointers note_pointers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_pointers
    ADD CONSTRAINT note_pointers_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: publish_snapshots publish_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publish_snapshots
    ADD CONSTRAINT publish_snapshots_pkey PRIMARY KEY (id);


--
-- Name: rss_staging rss_staging_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rss_staging
    ADD CONSTRAINT rss_staging_pkey PRIMARY KEY (id);


--
-- Name: rss_staging rss_staging_subscription_guid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rss_staging
    ADD CONSTRAINT rss_staging_subscription_guid_key UNIQUE (subscription_id, guid);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_key UNIQUE (slug);


--
-- Name: agent_tokens_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_tokens_active_idx ON public.agent_tokens USING btree (token_hash) WHERE (revoked_at IS NULL);


--
-- Name: agent_tokens_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_tokens_actor_idx ON public.agent_tokens USING btree (actor_id);


--
-- Name: content_nodes_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_nodes_active_idx ON public.content_nodes USING btree (workspace_id, updated_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: content_nodes_class_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_nodes_class_tag_idx ON public.content_nodes USING btree (workspace_id, node_type) WHERE (node_type = 'class_tag'::text);


--
-- Name: content_nodes_class_tag_workspace_parent_title_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX content_nodes_class_tag_workspace_parent_title_uq ON public.content_nodes USING btree (workspace_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), title) WHERE ((node_type = 'class_tag'::text) AND (deleted_at IS NULL));


--
-- Name: INDEX content_nodes_class_tag_workspace_parent_title_uq; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.content_nodes_class_tag_workspace_parent_title_uq IS 'A1.8: enforce uniqueness for class tag identity, replacing tags_workspace_parent_name_uq.';


--
-- Name: content_nodes_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_nodes_deleted_idx ON public.content_nodes USING btree (workspace_id, deleted_at DESC) WHERE (deleted_at IS NOT NULL);


--
-- Name: content_nodes_pgroonga_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_nodes_pgroonga_idx ON public.content_nodes USING pgroonga (title, markdown);


--
-- Name: content_nodes_workspace_slug_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX content_nodes_workspace_slug_uq ON public.content_nodes USING btree (workspace_id, slug) WHERE (deleted_at IS NULL);


CREATE UNIQUE INDEX content_nodes_reserved_key_uq ON public.content_nodes USING btree (workspace_id, reserved_key) WHERE ((reserved_key IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: INDEX content_nodes_workspace_slug_uq; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.content_nodes_workspace_slug_uq IS 'Closes the uniqueSlug() read-then-insert race: app code retries on 23505 against this index (services/nodes.ts retryOnSlugConflict).';


--
-- Name: dispatcher_pending_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dispatcher_pending_created ON public.dispatcher_pending USING btree (created_at);


--
-- Name: domain_events_actor_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_actor_window_idx ON public.domain_events USING btree (actor_id, created_at DESC);


--
-- Name: domain_events_body_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_body_hash_idx ON public.domain_events USING btree (body_hash) WHERE (body_hash IS NOT NULL);


--
-- Name: domain_events_restorable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_restorable_idx ON public.domain_events USING btree (workspace_id, created_at DESC) WHERE (external = false);


--
-- Name: domain_events_rewind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_rewind_idx ON public.domain_events USING btree (workspace_id, created_at) WHERE (tx_meta ? 'rewind_id'::text);


--
-- Name: domain_events_rewind_undo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_rewind_undo_idx ON public.domain_events USING btree (workspace_id, created_at) WHERE (tx_meta ? 'undoes_rewind'::text);


--
-- Name: domain_events_rolled_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_rolled_from_idx ON public.domain_events USING btree (workspace_id, ((payload ->> 'rolled_from'::text))) WHERE ((event_type = 'NODE_CREATED'::text) AND ((payload ->> 'rolled_from'::text) IS NOT NULL));


--
-- Name: domain_events_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_target_idx ON public.domain_events USING btree (target_type, target_id, created_at DESC);


--
-- Name: domain_events_triggered_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domain_events_triggered_by_idx ON public.domain_events USING btree (triggered_by_event_id) WHERE (triggered_by_event_id IS NOT NULL);


--
-- Name: event_reviews_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_reviews_workspace_idx ON public.event_reviews USING btree (workspace_id);


--
-- Name: idempotency_keys_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_created_idx ON public.idempotency_keys USING btree (created_at);


--
-- Name: node_attr_task_when; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_attr_task_when ON public.node_attributes USING btree (workspace_id, value) WHERE (key = '_task_when'::text);


--
-- Name: node_attr_task_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_attr_task_status ON public.node_attributes USING btree (workspace_id, value) WHERE (key = '_task_status'::text);


--
-- Name: node_attributes_inheritable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_attributes_inheritable_idx ON public.node_attributes USING btree (node_id) WHERE (is_inheritable = true);


--
-- Name: node_attributes_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_attributes_key_idx ON public.node_attributes USING btree (workspace_id, key);


--
-- Name: node_attributes_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_attributes_updated_at_idx ON public.node_attributes USING btree (workspace_id, updated_at DESC);


--
-- Name: block_nodes_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_nodes_workspace_idx ON public.block_nodes USING btree (workspace_id);


--
-- Name: block_nodes_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_nodes_parent_idx ON public.block_nodes USING btree (parent_block_id) WHERE (parent_block_id IS NOT NULL);


--
-- Name: block_node_tags_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_node_tags_tag_idx ON public.block_node_tags USING btree (tag_id);

-- Task lines (migration 122).
ALTER TABLE public.block_nodes ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES public.content_nodes(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS block_nodes_task_uq ON public.block_nodes (task_id) WHERE task_id IS NOT NULL;

-- Backup restore jobs (migration 123).
CREATE TABLE IF NOT EXISTS public.backup_restore_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  upload_id uuid NOT NULL UNIQUE,
  space_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('empty', 'merge', 'workspace')),
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  phase text NOT NULL DEFAULT 'reading',
  done integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  event_id bigint,
  error text,
  error_status integer,
  rolled_back boolean NOT NULL DEFAULT false,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS backup_restore_jobs_one_running_per_space ON public.backup_restore_jobs (space_id) WHERE status = 'running';

-- A person's own preferences on every device (migration 124).
CREATE TABLE IF NOT EXISTS public.actor_prefs (
  actor_id uuid NOT NULL REFERENCES public.actors(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  order_key double precision,
  PRIMARY KEY (actor_id, key)
);

-- Agent sessions: @mention an AI agent (migration 125).
CREATE TABLE IF NOT EXISTS public.agent_runners (
  actor_id        uuid PRIMARY KEY REFERENCES public.actors(id) ON DELETE CASCADE,  -- type = 'agent'
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  handle          text NOT NULL CHECK (handle = lower(handle) AND char_length(handle) BETWEEN 1 AND 32),
  enabled         boolean NOT NULL DEFAULT false,
  paused_until    timestamptz,
  max_concurrent  int NOT NULL DEFAULT 2 CHECK (max_concurrent > 0),
  max_per_hour    int NOT NULL DEFAULT 30 CHECK (max_per_hour > 0),
  timeout_seconds int NOT NULL DEFAULT 600 CHECK (timeout_seconds > 0),
  UNIQUE (workspace_id, handle)
);

CREATE TABLE IF NOT EXISTS public.agent_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  agent_actor_id     uuid NOT NULL REFERENCES public.actors(id) ON DELETE CASCADE,
  initiator_id       uuid NOT NULL REFERENCES public.actors(id) ON DELETE CASCADE,  -- who pressed send
  node_id            uuid NOT NULL REFERENCES public.content_nodes(id) ON DELETE CASCADE,
  space_id           uuid NOT NULL,          -- the note's space when sent: the session token's only space
  anchor_block_id    text NOT NULL,          -- ^id of the block holding the mention
  revision           int  NOT NULL DEFAULT 1,  -- re-sends of the same mention (not a sync cursor)
  parent_session_id  uuid REFERENCES public.agent_sessions(id) ON DELETE SET NULL,
  prompt             text NOT NULL,          -- snapshot of the text after @handle (skill reference removed)
  lead_in            text NOT NULL DEFAULT '', -- text of the block before @handle
  skill_node_id      uuid,                   -- NULL = the built-in `mention` skill
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN
                       ('queued','delivered','running','completed','failed','cancelled')),
  fail_code          text,
  root_event_id      bigint REFERENCES public.domain_events(id) ON DELETE SET NULL,  -- AGENT_SESSION_STARTED: the chain root
  reply_event_id     bigint REFERENCES public.domain_events(id) ON DELETE SET NULL,
  attempt            int  NOT NULL DEFAULT 0,
  claimed_by_token_id uuid,                  -- the runner token that claimed it
  created_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at       timestamptz,
  acked_at           timestamptz,
  finished_at        timestamptz,
  deadline_at        timestamptz NOT NULL,   -- created_at + the agent's timeout_seconds
  UNIQUE (workspace_id, node_id, anchor_block_id, revision)  -- one mention, one session
);
CREATE INDEX IF NOT EXISTS agent_sessions_open_idx ON public.agent_sessions (agent_actor_id, created_at)
  WHERE status IN ('queued','delivered','running');
CREATE INDEX IF NOT EXISTS agent_sessions_agent_recent_idx ON public.agent_sessions (agent_actor_id, created_at DESC);

-- Append-only progress log. Not a domain event stream: it never syncs and
-- is never restored.
CREATE TABLE IF NOT EXISTS public.agent_session_events (
  session_id uuid NOT NULL REFERENCES public.agent_sessions(id) ON DELETE CASCADE,
  seq        int  NOT NULL,                  -- chosen by the runner: (session_id, seq) de-duplicates re-sends
  kind       text NOT NULL CHECK (kind IN ('ack','thought','action','message','error','result')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

-- A session token belongs to one session and dies with it.
ALTER TABLE public.agent_tokens ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.agent_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_tokens_session_idx ON public.agent_tokens (session_id) WHERE session_id IS NOT NULL;


--
-- Name: node_edges_unique_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX node_edges_unique_origin_idx ON public.node_edges USING btree (workspace_id, source_node_id, target_node_id, edge_type, origin);


--
-- Name: node_embeddings_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_embeddings_hnsw ON public.node_embeddings USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: node_embeddings_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_embeddings_ws ON public.node_embeddings USING btree (workspace_id);


--
-- Name: node_positions_surface; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_positions_surface ON public.node_positions USING btree (surface);


--
-- Name: node_positions_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_positions_ws ON public.node_positions USING btree (workspace_id);


--
-- Name: node_tag_states_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_tag_states_tag_idx ON public.node_tag_states USING btree (tag_id);


--
-- Name: node_tags_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_tags_tag_idx ON public.node_tags USING btree (tag_id);


--
-- Name: note_pointers_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX note_pointers_parent_idx ON public.note_pointers USING btree (workspace_id, parent_id, order_key);


--
-- Name: note_pointers_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX note_pointers_target_idx ON public.note_pointers USING btree (workspace_id, target_id);


--
-- Name: outbox_awaiting_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_awaiting_approval ON public.outbox USING btree (workspace_id, created_at DESC) WHERE (status = 'pending_approval'::text);


--
-- Name: outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_due ON public.outbox USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: outbox_pending_approval_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outbox_pending_approval_dedup ON public.outbox USING btree (dedup_key) WHERE (status = 'pending_approval'::text);


--
-- Name: outbox_pending_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outbox_pending_dedup ON public.outbox USING btree (dedup_key) WHERE (status = 'pending'::text);


--
-- Name: rate_limit_hits_token_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_limit_hits_token_time_idx ON public.rate_limit_hits USING btree (token_id, hit_at);


--
-- Name: rss_staging_subscription_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rss_staging_subscription_ts_idx ON public.rss_staging USING btree (subscription_id, COALESCE(published_at, fetched_at) DESC);


--
-- Name: rss_staging_unseen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rss_staging_unseen_idx ON public.rss_staging USING btree (subscription_id) WHERE ((seen_at IS NULL) AND (tombstoned_at IS NULL));


--
-- Name: content_nodes content_nodes_note_link_index_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_nodes_note_link_index_insert AFTER INSERT ON public.content_nodes FOR EACH ROW EXECUTE FUNCTION public.note_link_index_new_note();


--
-- Name: content_nodes content_nodes_note_link_index_text; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_nodes_note_link_index_text AFTER UPDATE OF markdown ON public.content_nodes FOR EACH ROW WHEN ((old.markdown IS DISTINCT FROM new.markdown)) EXECUTE FUNCTION public.note_link_index_text_changed();


--
-- Name: dispatcher_pending dispatcher_pending_actor_ref; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dispatcher_pending_actor_ref BEFORE INSERT OR UPDATE OF actor_id ON public.dispatcher_pending FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('actor_id');


--
-- Name: domain_events domain_events_actor_ref; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER domain_events_actor_ref BEFORE INSERT ON public.domain_events FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('actor_id');


--
-- Name: domain_events domain_events_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON public.domain_events FOR EACH ROW EXECUTE FUNCTION public.domain_events_prevent_delete();


--
-- Name: domain_events domain_events_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON public.domain_events FOR EACH ROW EXECUTE FUNCTION public.domain_events_immutable();


--
-- Name: event_reviews event_reviews_reviewed_by_ref; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_reviews_reviewed_by_ref BEFORE INSERT OR UPDATE OF reviewed_by ON public.event_reviews FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('reviewed_by');


--
-- Name: node_tags node_tags_state_tracking; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER node_tags_state_tracking AFTER INSERT OR DELETE OR UPDATE ON public.node_tags FOR EACH ROW EXECUTE FUNCTION public.track_node_tag_state();


--
-- Name: actors actors_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: agent_tokens agent_tokens_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actors(id) ON DELETE CASCADE;


--
-- Name: ai_suggestions ai_suggestions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_suggestions
    ADD CONSTRAINT ai_suggestions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: content_nodes content_nodes_deleted_by_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_nodes
    ADD CONSTRAINT content_nodes_deleted_by_event_id_fkey FOREIGN KEY (deleted_by_event_id) REFERENCES public.domain_events(id) ON DELETE SET NULL;


--
-- Name: content_nodes content_nodes_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_nodes
    ADD CONSTRAINT content_nodes_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.content_nodes(id) ON DELETE SET NULL;


--
-- Name: content_nodes content_nodes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_nodes
    ADD CONSTRAINT content_nodes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: domain_events domain_events_triggered_by_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_triggered_by_event_id_fkey FOREIGN KEY (triggered_by_event_id) REFERENCES public.domain_events(id) ON DELETE SET NULL;


--
-- Name: domain_events domain_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: event_reviews event_reviews_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_reviews
    ADD CONSTRAINT event_reviews_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.domain_events(id) ON DELETE CASCADE;


--
-- Name: event_reviews event_reviews_restore_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_reviews
    ADD CONSTRAINT event_reviews_restore_event_id_fkey FOREIGN KEY (restore_event_id) REFERENCES public.domain_events(id) ON DELETE SET NULL;


--
-- Name: event_reviews event_reviews_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_reviews
    ADD CONSTRAINT event_reviews_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: idempotency_keys idempotency_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: imported_media imported_media_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imported_media
    ADD CONSTRAINT imported_media_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: member_removals member_removals_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_removals
    ADD CONSTRAINT member_removals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: node_attributes node_attributes_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_attributes
    ADD CONSTRAINT node_attributes_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_attributes node_attributes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_attributes
    ADD CONSTRAINT node_attributes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: block_nodes block_nodes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_nodes
    ADD CONSTRAINT block_nodes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: block_nodes block_nodes_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_nodes
    ADD CONSTRAINT block_nodes_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: note_block_refs; Type: FK CONSTRAINT; Schema: public; Owner: -
--

CREATE INDEX note_block_refs_lookup_idx ON public.note_block_refs (workspace_id, block_ref);
ALTER TABLE ONLY public.note_block_refs
    ADD CONSTRAINT note_block_refs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.note_block_refs
    ADD CONSTRAINT note_block_refs_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: note_link_index; Type: FK CONSTRAINT; Schema: public; Owner: -
--

CREATE INDEX note_link_index_lc_idx ON public.note_link_index USING gin (link_lc);
CREATE INDEX note_link_index_slug_idx ON public.note_link_index USING gin (link_slug);
CREATE INDEX note_link_index_stale_idx ON public.note_link_index (workspace_id) WHERE stale;
ALTER TABLE ONLY public.note_link_index
    ADD CONSTRAINT note_link_index_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.note_link_index
    ADD CONSTRAINT note_link_index_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.content_nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: block_nodes block_nodes_parent_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_nodes
    ADD CONSTRAINT block_nodes_parent_block_id_fkey FOREIGN KEY (parent_block_id) REFERENCES public.block_nodes(id) ON DELETE SET NULL;


--
-- Name: block_node_tags block_node_tags_block_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_node_tags
    ADD CONSTRAINT block_node_tags_block_node_id_fkey FOREIGN KEY (block_node_id) REFERENCES public.block_nodes(id) ON DELETE CASCADE;


--
-- Name: block_node_tags block_node_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_node_tags
    ADD CONSTRAINT block_node_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: block_node_tags block_node_tags_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_node_tags
    ADD CONSTRAINT block_node_tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: node_edges node_edges_source_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_edges
    ADD CONSTRAINT node_edges_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_edges node_edges_target_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_edges
    ADD CONSTRAINT node_edges_target_node_id_fkey FOREIGN KEY (target_node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_edges node_edges_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_edges
    ADD CONSTRAINT node_edges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: node_embeddings node_embeddings_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_embeddings
    ADD CONSTRAINT node_embeddings_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: board_copy_folds board_copy_folds_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_copy_folds
    ADD CONSTRAINT board_copy_folds_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: board_copy_unparents board_copy_unparents_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_copy_unparents
    ADD CONSTRAINT board_copy_unparents_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: board_ink_moves board_ink_moves_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_ink_moves
    ADD CONSTRAINT board_ink_moves_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: canvas_note_conversions canvas_note_conversions_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_note_conversions
    ADD CONSTRAINT canvas_note_conversions_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_positions node_positions_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_positions
    ADD CONSTRAINT node_positions_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_tag_states node_tag_states_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_tag_states
    ADD CONSTRAINT node_tag_states_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_tag_states node_tag_states_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_tag_states
    ADD CONSTRAINT node_tag_states_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_tags node_tags_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_tags
    ADD CONSTRAINT node_tags_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: node_tags node_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_tags
    ADD CONSTRAINT node_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: note_pointers note_pointers_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_pointers
    ADD CONSTRAINT note_pointers_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: note_pointers note_pointers_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_pointers
    ADD CONSTRAINT note_pointers_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;


--
-- Name: note_pointers note_pointers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_pointers
    ADD CONSTRAINT note_pointers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: publish_snapshots publish_snapshots_home_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publish_snapshots
    ADD CONSTRAINT publish_snapshots_home_node_id_fkey FOREIGN KEY (home_node_id) REFERENCES public.content_nodes(id) ON DELETE SET NULL;


--
-- Name: publish_snapshots publish_snapshots_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publish_snapshots
    ADD CONSTRAINT publish_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: rss_staging rss_staging_saved_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rss_staging
    ADD CONSTRAINT rss_staging_saved_node_id_fkey FOREIGN KEY (saved_node_id) REFERENCES public.content_nodes(id) ON DELETE SET NULL;


--
-- Name: rss_staging rss_staging_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rss_staging
    ADD CONSTRAINT rss_staging_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_home_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_home_node_id_fkey FOREIGN KEY (home_node_id) REFERENCES public.content_nodes(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict tXERIUh6s2kZD5Wm0LJCJYcsdQ3jZxug0nz7tPWbmzSNCf6Q9s01dRDFkRJbyH5


-- pg_dump 18 \restrict pins an EMPTY search_path for the whole session —
-- everything below the dump must qualify or reset it explicitly.
SET search_path = public;

-- Who uploaded each media file (docs/architecture/spaces.md, phase 0).
--
-- A media file had no owner record: canReadMedia let anyone who could read ANY
-- node referencing `/api/media/<file>` read it, so pasting a seen URL into
-- your own note granted permanent access. Reads now follow the OLDEST
-- referencing node (the one the file was attached to); this table answers who
-- may preview an upload before any note references it. Files from before this
-- migration have no row and keep the old "any signed-in member" preview rule.
CREATE TABLE IF NOT EXISTS media_uploads (
  filename text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploader_actor_id text NOT NULL,  -- actors.id as text, like imported_media.actor_id
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-person module progress (docs/architecture/spaces.md, 「模組的個人進度」).
--
-- Notes are shared; how far each person got with them is not. Review state,
-- "seen" in the RSS reader and "done" in read-later were stored once per note
-- (a `_review_state` attribute, rss_staging.seen_at, removing the tag), so one
-- person's study or reading moved everyone else's. RemNote's shared knowledge
-- bases have exactly this complaint; AnkiHub and Feedly keep progress per
-- person. Rows here are keyed by (thing, actor); actor ids are stored as text
-- like imported_media.actor_id, and member removal deletes them
-- (services/memberRemovals.ts).

-- FSRS state per (card, person). Replaces the `_review_state` attribute. A card is a note (node_id) or a block node
-- (block_id, migration 120; one table since 183): exactly one is set, each unique per person.
CREATE TABLE IF NOT EXISTS review_states (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid REFERENCES content_nodes(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  state text NOT NULL,
  -- The state before the latest grade: one-step "undo grade" for its owner.
  previous_state text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  block_id uuid REFERENCES block_nodes(id) ON DELETE CASCADE,
  CONSTRAINT review_states_one_card CHECK (num_nonnulls(node_id, block_id) = 1)
);
CREATE INDEX IF NOT EXISTS review_states_actor_idx ON review_states (workspace_id, actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_states_node_actor ON review_states (node_id, actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_states_block_actor ON review_states (block_id, actor_id);

-- "I have seen this feed item" per person. rss_staging.seen_at stays the
-- stream's own lifecycle (pre-seen backfill, auto-aging, tombstoning).
CREATE TABLE IF NOT EXISTS rss_seen (
  staging_id uuid NOT NULL REFERENCES rss_staging(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  -- false = this person marked it unseen again, even after the stream aged it.
  seen boolean NOT NULL DEFAULT true,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staging_id, actor_id)
);

-- "I finished reading this" per person, kept after read-later was removed (migration 192 renamed read_later_done; dropped in a later release).
CREATE TABLE IF NOT EXISTS read_later_done_removed_192 (
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  done_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, actor_id)
);

-- Personal overrides of a module tag's settings (review: new cards per day,
-- target recall, longest interval). Layering like VS Code: module default →
-- tag setting → personal override.
CREATE TABLE IF NOT EXISTS actor_module_settings (
  actor_id text NOT NULL,
  tag_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  settings jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, tag_id)
);

-- Spaces (docs/architecture/spaces.md, phase 1a).
--
-- Every note lives in exactly one space; space membership (viewer / editor /
-- manager) will decide who can read and write it. Tags never carry permission
-- and their definitions are global (space_id NULL).
--
-- Phase 1a only ADDS the structure and keeps it consistent. Reads and writes
-- are still decided by the old rules; the space rule runs beside them in
-- shadow mode (services/spaces.ts) until phase 3 switches over. So this
-- migration must not change what anyone can see:
--   * one shared default space 「共用」 holds every existing note, with every
--     member in it (viewer → viewer, editor/reviewer → editor, admin → manager)
--     and every capability on (publish / external_ai / backup keep working);
--   * each human gets an empty personal space.

-- The workspace owner: the one principal the spaces design gives permission
-- administration to. Today "principal" means any non-token admin; the owner is
-- the earliest human admin.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL;
UPDATE workspaces w
   SET owner_actor_id = (
     SELECT a.id FROM actors a
      WHERE a.workspace_id = w.id AND a.type = 'human' AND a.role = 'admin'
      ORDER BY a.created_at, a.id LIMIT 1)
 WHERE w.owner_actor_id IS NULL;

CREATE TABLE IF NOT EXISTS spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal', 'shared', 'system')),
  -- The personal space's person.
  owner_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  -- Where a note goes when nothing else says (root creates without a space
  -- during phases 1–2). Exactly one per workspace.
  is_default boolean NOT NULL DEFAULT false,
  -- {"publish": bool, "external_ai": bool, "backup": bool, "shared_seen": bool}
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_default_idx ON spaces (workspace_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_personal_idx ON spaces (owner_actor_id) WHERE kind = 'personal' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS space_members (
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, actor_id)
);
CREATE INDEX IF NOT EXISTS space_members_actor_idx ON space_members (actor_id);

ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES spaces(id);
CREATE INDEX IF NOT EXISTS content_nodes_space_idx ON content_nodes (workspace_id, space_id) WHERE deleted_at IS NULL;

-- Backfill: the default shared space, its members, personal spaces.
INSERT INTO spaces (workspace_id, name, kind, is_default, capabilities)
SELECT w.id, '共用', 'shared', true,
       '{"publish": false, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb
  FROM workspaces w
 WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id AND s.is_default);

INSERT INTO space_members (space_id, actor_id, role)
SELECT s.id, a.id,
       CASE a.role WHEN 'viewer' THEN 'viewer' WHEN 'admin' THEN 'manager' ELSE 'editor' END
  FROM spaces s JOIN actors a ON a.workspace_id = s.workspace_id
 WHERE s.is_default
ON CONFLICT (space_id, actor_id) DO NOTHING;

INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
SELECT a.workspace_id, 'personal', 'personal', a.id,
       '{"publish": false, "external_ai": false, "backup": true, "shared_seen": false}'::jsonb
  FROM actors a
 WHERE a.type = 'human'
   AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.owner_actor_id = a.id AND s.kind = 'personal' AND s.deleted_at IS NULL);

INSERT INTO space_members (space_id, actor_id, role)
SELECT s.id, s.owner_actor_id, 'manager' FROM spaces s
 WHERE s.kind = 'personal' AND s.owner_actor_id IS NOT NULL
ON CONFLICT (space_id, actor_id) DO NOTHING;

UPDATE content_nodes n
   SET space_id = s.id
  FROM spaces s
 WHERE s.workspace_id = n.workspace_id AND s.is_default
   AND n.space_id IS NULL AND n.node_type <> 'class_tag';

-- A note's space: tag definitions are global (NULL); everything else has one.
-- Derived on write so the many INSERT paths need no change: a child takes its
-- parent's space (a tag parent is "global", so it does not pass one down), and
-- a root falls back to the workspace's default space.
CREATE OR REPLACE FUNCTION content_nodes_derive_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_space uuid;
  parent_type text;
BEGIN
  IF NEW.node_type = 'class_tag' THEN
    NEW.space_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.space_id IS NULL THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT space_id, node_type INTO parent_space, parent_type FROM content_nodes WHERE id = NEW.parent_id;
      IF parent_type IS DISTINCT FROM 'class_tag' THEN NEW.space_id := parent_space; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      SELECT id INTO NEW.space_id FROM spaces WHERE workspace_id = NEW.workspace_id AND is_default;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS content_nodes_derive_space ON content_nodes;
CREATE TRIGGER content_nodes_derive_space
  BEFORE INSERT OR UPDATE OF space_id, parent_id, node_type ON content_nodes
  FOR EACH ROW EXECUTE FUNCTION content_nodes_derive_space();

-- A child is always in its parent's space (unless the parent is a global tag).
-- Checked at COMMIT (deferred) so a whole subtree can move in one statement in
-- any row order. Checked from both sides: the row's own parent, and the row's
-- children (a node whose space changed must have brought its children along).
CREATE OR REPLACE FUNCTION content_nodes_check_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur record;
  bad uuid;
BEGIN
  SELECT id, parent_id, space_id, node_type INTO cur FROM content_nodes WHERE id = NEW.id;
  IF NOT FOUND OR cur.node_type = 'class_tag' THEN RETURN NULL; END IF;
  IF cur.parent_id IS NOT NULL THEN
    SELECT p.id INTO bad FROM content_nodes p
     WHERE p.id = cur.parent_id AND p.node_type <> 'class_tag' AND p.space_id IS DISTINCT FROM cur.space_id;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'node % is in a different space than its parent %', cur.id, bad
        USING ERRCODE = 'check_violation', CONSTRAINT = 'content_nodes_space_matches_parent';
    END IF;
  END IF;
  SELECT c.id INTO bad FROM content_nodes c
   WHERE c.parent_id = cur.id AND c.node_type <> 'class_tag' AND c.space_id IS DISTINCT FROM cur.space_id
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'node % is in a different space than its parent %', bad, cur.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'content_nodes_space_matches_parent';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS content_nodes_check_space ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_check_space
  AFTER INSERT OR UPDATE OF space_id, parent_id, node_type ON content_nodes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION content_nodes_check_space();

-- Phases 1–2 keep space membership in step with the old model, so the shadow
-- comparison measures the real policy differences and nothing else:
--   * a new workspace gets its default shared space;
--   * every actor is in the default space with the role-mapped space role,
--     updated when the role changes;
--   * every human gets a personal space;
--   * the first human admin becomes the workspace owner.
-- Phase 3 drops these triggers; membership is then managed only through the
-- spaces API.
CREATE OR REPLACE FUNCTION workspaces_default_space() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO spaces (workspace_id, name, kind, is_default, capabilities)
  VALUES (NEW.id, '共用', 'shared', true, '{"publish": false, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS workspaces_default_space ON workspaces;
CREATE TRIGGER workspaces_default_space AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_default_space();

CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  personal uuid;
BEGIN
  INSERT INTO space_members (space_id, actor_id, role)
  SELECT s.id, NEW.id,
         CASE NEW.role WHEN 'viewer' THEN 'viewer' WHEN 'admin' THEN 'manager' ELSE 'editor' END
    FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
  ON CONFLICT (space_id, actor_id) DO UPDATE SET role = EXCLUDED.role;
  IF TG_OP = 'INSERT' AND NEW.type = 'human' THEN
    IF NOT EXISTS (SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
      INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
      VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
              '{"publish": false, "external_ai": false, "backup": true, "shared_seen": false}'::jsonb)
      RETURNING id INTO personal;
      INSERT INTO space_members (space_id, actor_id, role) VALUES (personal, NEW.id, 'manager');
    END IF;
  END IF;
  IF NEW.type = 'human' AND NEW.role = 'admin' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS actors_sync_spaces ON actors;
CREATE TRIGGER actors_sync_spaces AFTER INSERT OR UPDATE OF role ON actors
  FOR EACH ROW EXECUTE FUNCTION actors_sync_spaces();

-- Spaces decide access from now on (docs/architecture/spaces.md).
--
-- One-time conversion, then the old tag-permission model goes:
--   * notes already sit in the default shared space (migration 093), with
--     every member in it and every capability on — nobody's access changes;
--   * the cases the old model could express and spaces cannot are handled
--     fail-closed (each logged with RAISE NOTICE):
--       - a note carrying a tag with an access policy (and its subtree) moves
--         into an owner-only space 「受限」, detached from an unrestricted parent;
--       - a member limited to some tags (scoped_tag_ids) leaves the default
--         space and keeps only their personal space;
--       - an agent token limited to some tags (allowed_tag_ids) is left with no
--         spaces until it is re-scoped;
--   * tag policies, member tag scopes, token tag scopes and the epoch bump on
--     every tagging are removed.

-- Agent tokens reach spaces: NULL = every space the token's agent belongs
-- to, further limited to spaces whose external_ai switch is on.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS read_space_ids uuid[];
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS write_space_ids uuid[];

DO $$
DECLARE
  w record;
  owner uuid;
  restricted uuid;
  root record;
  moved int;
  n int;
BEGIN
  FOR w IN SELECT id, owner_actor_id FROM workspaces LOOP
    owner := w.owner_actor_id;
    -- Notes directly carrying a policy-bearing tag, with no such tag above
    -- them (their subtree comes along).
    FOR root IN
      WITH policy_tags AS (
        SELECT id FROM content_nodes
         WHERE workspace_id = w.id AND node_type = 'class_tag'
           AND jsonb_typeof(tag_schema->'policy') = 'object' AND tag_schema->'policy' <> '{}'::jsonb
      ), tagged AS (
        SELECT DISTINCT nt.node_id AS id FROM node_tags nt JOIN policy_tags p ON p.id = nt.tag_id
          JOIN content_nodes c ON c.id = nt.node_id AND c.node_type <> 'class_tag'
      )
      SELECT t.id, c.parent_id FROM tagged t JOIN content_nodes c ON c.id = t.id
       WHERE NOT EXISTS (
         WITH RECURSIVE up AS (
           SELECT c.parent_id AS id
           UNION
           SELECT p.parent_id FROM content_nodes p JOIN up ON p.id = up.id WHERE p.parent_id IS NOT NULL
         )
         SELECT 1 FROM up JOIN tagged t2 ON t2.id = up.id)
    LOOP
      IF restricted IS NULL OR NOT EXISTS (SELECT 1 FROM spaces WHERE id = restricted AND workspace_id = w.id) THEN
        INSERT INTO spaces (workspace_id, name, kind, capabilities)
        VALUES (w.id, '受限', 'shared', '{"publish": false, "external_ai": false, "backup": true, "shared_seen": false}'::jsonb)
        RETURNING id INTO restricted;
        IF owner IS NOT NULL THEN
          INSERT INTO space_members (space_id, actor_id, role) VALUES (restricted, owner, 'manager');
        END IF;
        RAISE NOTICE 'spaces: workspace % had notes behind tag access policies; they move to an owner-only space 受限 (%)', w.id, restricted;
      END IF;
      UPDATE content_nodes SET parent_id = NULL WHERE id = root.id AND root.parent_id IS NOT NULL;
      WITH RECURSIVE sub AS (
        SELECT root.id AS id
        UNION
        SELECT c.id FROM content_nodes c JOIN sub ON c.parent_id = sub.id WHERE c.node_type <> 'class_tag'
      )
      UPDATE content_nodes SET space_id = restricted WHERE id IN (SELECT id FROM sub);
      GET DIAGNOSTICS moved = ROW_COUNT;
      RAISE NOTICE 'spaces: note % and % notes under it moved to 受限', root.id, moved - 1;
    END LOOP;
    restricted := NULL;

    -- Members limited to some tags: fail closed to their personal space.
    -- (Guarded: the column is gone once this migration has run.)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'actors' AND column_name = 'scoped_tag_ids') THEN
      FOR root IN EXECUTE 'SELECT id, name FROM actors WHERE workspace_id = $1 AND scoped_tag_ids IS NOT NULL' USING w.id LOOP
        DELETE FROM space_members m USING spaces s
         WHERE m.space_id = s.id AND s.is_default AND s.workspace_id = w.id AND m.actor_id = root.id;
        RAISE NOTICE 'spaces: member % (%) was limited to some tags; now only their personal space until added to spaces', root.name, root.id;
      END LOOP;
    END IF;

    -- Tokens limited to some tags: no spaces until re-scoped.
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tokens' AND column_name = 'allowed_tag_ids') THEN
      EXECUTE 'UPDATE agent_tokens t SET read_space_ids = ''{}'', write_space_ids = ''{}''
                 FROM actors a WHERE a.id = t.actor_id AND a.workspace_id = $1 AND t.allowed_tag_ids IS NOT NULL' USING w.id;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE NOTICE 'spaces: % agent tokens were limited to tags; they reach no space until re-scoped', n; END IF;
    END IF;
  END LOOP;
END $$;

-- The old model goes.
UPDATE content_nodes SET tag_schema = tag_schema - 'policy' WHERE tag_schema ? 'policy';
DROP TRIGGER IF EXISTS node_tags_membership_bump ON node_tags;
DROP FUNCTION IF EXISTS bump_membership_on_node_tag();
ALTER TABLE actors DROP COLUMN IF EXISTS scoped_tag_ids;
ALTER TABLE agent_tokens DROP COLUMN IF EXISTS allowed_tag_ids;

-- Membership is managed through spaces now: a role change no longer rewrites
-- anyone's space membership. A new member joins the default space (role
-- mapped: viewer → viewer, admin → manager, else editor) and gets a personal
-- space; only the workspace owner's personal space is in the owner's backup.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  personal uuid;
BEGIN
  INSERT INTO space_members (space_id, actor_id, role)
  SELECT s.id, NEW.id,
         CASE NEW.role WHEN 'viewer' THEN 'viewer' WHEN 'admin' THEN 'manager' ELSE 'editor' END
    FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
  ON CONFLICT (space_id, actor_id) DO NOTHING;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id IS NULL OR owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), true)))
    RETURNING id INTO personal;
    INSERT INTO space_members (space_id, actor_id, role) VALUES (personal, NEW.id, 'manager');
  END IF;
  IF NEW.type = 'human' AND NEW.role = 'admin' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS actors_sync_spaces ON actors;
CREATE TRIGGER actors_sync_spaces AFTER INSERT ON actors
  FOR EACH ROW EXECUTE FUNCTION actors_sync_spaces();

-- Only the workspace owner's personal space is in the owner's backup.
UPDATE spaces s SET capabilities = s.capabilities || '{"backup": false}'::jsonb
  FROM workspaces w
 WHERE s.workspace_id = w.id AND s.kind = 'personal'
   AND s.owner_actor_id IS DISTINCT FROM w.owner_actor_id;

-- A root note created without a parent or an explicit space lands in the
-- creator's personal space (mutate() sets onden.actor_space for the
-- transaction), otherwise the workspace's default space.
CREATE OR REPLACE FUNCTION content_nodes_derive_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_space uuid;
  parent_type text;
  actor_space text;
BEGIN
  IF NEW.node_type = 'class_tag' THEN
    NEW.space_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.space_id IS NULL THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT space_id, node_type INTO parent_space, parent_type FROM content_nodes WHERE id = NEW.parent_id;
      IF parent_type IS DISTINCT FROM 'class_tag' THEN NEW.space_id := parent_space; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      actor_space := NULLIF(current_setting('onden.actor_space', true), '');
      IF actor_space IS NOT NULL THEN NEW.space_id := actor_space::uuid; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      -- A background job (spine/systemJobs.ts; mutate() sets onden.system_actor)
      -- has no personal space: it names a parent or a space, or the create fails.
      IF current_setting('onden.system_actor', true) = 'on' THEN
        RAISE EXCEPTION 'a system job has no personal space: give the new note a parent or a space'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT id INTO NEW.space_id FROM spaces WHERE workspace_id = NEW.workspace_id AND is_default;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Which note owns an uploaded file (docs/architecture/spaces.md, phase 0;
-- docs/research/integration-audit-2026-10-13.md, pre-invite item 6).
--
-- canReadMedia let the OLDEST note referencing `/api/media/<file>` decide who
-- may read it. Someone who had once seen the URL could paste it into an older
-- note of their own and read the file forever. The file now belongs to the
-- first note saved with a reference to it (services/mediaOwners.ts); a
-- reference added later from another note does not change that.
ALTER TABLE media_uploads ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL;

-- Files uploaded before: the note that decided until now, the oldest one
-- referencing it from its body or site layout.
UPDATE media_uploads m SET node_id = (
  SELECT n.id FROM content_nodes n
   WHERE n.workspace_id = m.workspace_id
     AND (strpos(lower(coalesce(n.markdown, '')), lower('/api/media/' || m.filename)) > 0
          OR strpos(lower(coalesce(n.presentation::text, '')), lower('/api/media/' || m.filename)) > 0)
   ORDER BY n.created_at, n.id
   LIMIT 1)
 WHERE m.node_id IS NULL;

-- The workspace settings in a place no note surface serves
-- (docs/architecture/spaces.md 「workspace 設定節點保護」; audit D2 in
-- docs/research/integration-audit-2026-10-13.md).
--
-- The hidden Site Config note holds the site settings and two secrets: the
-- hosted-share token and the site's access tokens. In 共用 it reached every
-- member, and their agents, through bootstrap and the note routes. It now
-- sits in a `system` space with no members, so no member, owner or token reads
-- it as a note. The server reads and writes it through the settings functions
-- (services/siteConfig.ts), and the owner changes it through PATCH
-- /api/workspace/config.
INSERT INTO spaces (workspace_id, name, kind, capabilities)
SELECT w.id, 'system', 'system', '{"publish": false, "external_ai": false, "backup": false, "shared_seen": false}'::jsonb
  FROM workspaces w
 WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id AND s.kind = 'system' AND s.deleted_at IS NULL);

-- Only the Site Config note itself: the system-made note carrying the ROOT
-- workspace-config tag. Tag titles are unique per parent, so a member's
-- nested `#foo/workspace-config` must not pull ordinary notes in here.
UPDATE content_nodes n SET space_id = s.id
  FROM spaces s
 WHERE s.workspace_id = n.workspace_id AND s.kind = 'system' AND s.deleted_at IS NULL
   AND n.node_type = 'content' AND n.source_type = 'system'
   AND EXISTS (SELECT 1 FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id
                WHERE nt.node_id = n.id AND t.node_type = 'class_tag' AND t.parent_id IS NULL
                  AND t.title = 'workspace-config');

-- Space membership is explicit (pre-invite list, docs/research/integration-audit-2026-10-13.md §4.3).
--
-- Until now a new member joined the default space 共用 automatically, and the
-- existing notes all live there: the second person invited would have seen
-- every note the owner ever wrote. Now a new member gets only their personal
-- space; the owner adds them to spaces (共用 included) in Settings › Spaces.
-- The first human admin becomes the workspace owner and manages the default
-- space; the System actor is added by the boot seeding (db.ts). Existing
-- memberships are left as they are.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  personal uuid;
  became_owner boolean := false;
BEGIN
  IF NEW.type = 'human' AND NEW.role = 'admin' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
    became_owner := FOUND;
  END IF;
  IF became_owner THEN
    INSERT INTO space_members (space_id, actor_id, role)
    SELECT s.id, NEW.id, 'manager' FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), false)))
    RETURNING id INTO personal;
    INSERT INTO space_members (space_id, actor_id, role) VALUES (personal, NEW.id, 'manager');
  END IF;
  RETURN NULL;
END $$;

-- A token never reaches beyond the person who issued it
-- (docs/research/integration-audit-2026-10-13.md §4.4): its spaces are
-- min(issuer's spaces, the token's grant) — read needs the issuer to be in the
-- space, write needs the issuer to be an editor or manager there. Tokens were
-- only mintable by the workspace owner, so existing ones are attributed to the
-- owner.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS issued_by uuid REFERENCES actors(id) ON DELETE SET NULL;
UPDATE agent_tokens t SET issued_by = w.owner_actor_id
  FROM actors a JOIN workspaces w ON w.id = a.workspace_id
 WHERE a.id = t.actor_id AND t.issued_by IS NULL AND w.owner_actor_id IS NOT NULL;

-- A slug is unique within a space, not the whole workspace
-- (docs/research/integration-audit-2026-10-13.md, v1 gap 2): creating "Plan"
-- and getting "plan-2" used to reveal that someone in another space has a
-- note called Plan. Tag definitions (no space) stay unique among themselves.
DROP INDEX IF EXISTS content_nodes_workspace_slug_uq;
CREATE UNIQUE INDEX IF NOT EXISTS content_nodes_space_slug_uq ON content_nodes
  (workspace_id, COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL;
COMMENT ON INDEX content_nodes_space_slug_uq IS 'Slug unique per space (tags: per workspace). Closes the uniqueSlug() read-then-insert race: app code retries on 23505 (services/nodes.ts retryOnSlugConflict).';

-- Removing a member ends the tokens they issued (W35). Migration 098 bounds a
-- token by its issuer's spaces, but issued_by is ON DELETE SET NULL and a NULL
-- issuer meant "keep the stored grant": deleting the issuer WIDENED their
-- tokens to the raw grant. DELETE /api/actors/:id now revokes them
-- (services/agentTokens.ts revokeTokensIssuedBy); this column records that the
-- token once had an issuer who is gone, so the effective spaces
-- (services/currentActor.ts EFFECTIVE_TOKEN_SPACES_SQL) are empty for it even
-- if some other path deletes the actor. A NULL issuer without this mark is a
-- token 098 could not attribute (no workspace owner then) and keeps its grant.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS issuer_removed_at timestamptz;

CREATE OR REPLACE FUNCTION mark_tokens_issuer_removed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_tokens SET issuer_removed_at = now()
   WHERE issued_by = OLD.id AND issuer_removed_at IS NULL;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS actors_mark_tokens_issuer_removed ON actors;
CREATE TRIGGER actors_mark_tokens_issuer_removed BEFORE DELETE ON actors
  FOR EACH ROW EXECUTE FUNCTION mark_tokens_issuer_removed();

-- Adding a person is an invite with an email (119, audit D110): the row waits
-- (external_id NULL) until the first sign-in with that email claims it
-- (services/actors.ts actorForSession). Stored trimmed and lower case; only an
-- unclaimed invite reserves the address.
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_email text;
ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_invite_email_normalised;
ALTER TABLE actors ADD CONSTRAINT actors_invite_email_normalised
  CHECK (invite_email IS NULL OR (invite_email = lower(btrim(invite_email)) AND invite_email <> ''));
CREATE UNIQUE INDEX IF NOT EXISTS actors_pending_invite_email_uq ON actors (workspace_id, invite_email)
  WHERE type = 'human' AND external_id IS NULL AND invite_email IS NOT NULL;
-- The one-time invite link: only the token's sha256 is kept (as
-- agent_tokens.token_hash), valid 14 days, spent by the claim. The claim needs
-- BOTH this token and the login's email to match: knowing the address alone
-- no longer takes the invite.
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_token_hash text;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_used_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS actors_invite_token_hash_uq ON actors (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

-- ── 127_owner_member (db/migrations/127_owner_member.sql, appended as the snapshot convention) ──
-- 126: only an owner and members; space permission view / edit; token access
-- read / write (docs/architecture/proposals/roles-owner-member-2026-10-22.md
-- §7.3, decisions in §9). One conversion, no compatibility period: the old
-- columns are removed here.
--
-- Principle (§8.1): nobody and no token reaches more after this than before.
--   * actors.role (viewer/editor/reviewer/admin) never gated reading or writing
--     (spaces do); it only decided who owns the workspace as a fallback and who
--     reviews. Both now belong to workspaces.owner_actor_id alone.
--   * space_members.role viewer -> view; editor, manager -> edit. Managing a
--     space is no longer member data: the workspace owner manages shared
--     spaces, a person manages their own personal space.
--   * agent_tokens: the per-token space lists and the issuer clamp are gone, so
--     an agent's reach is its own space membership. To keep every token's reach
--     the same or narrower, each agent's membership is cut down to what ALL its
--     live tokens could reach before (the intersection, decision 5).
-- Everything that changes is written to owner_member_migration_log.

CREATE TABLE owner_member_migration_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  step text NOT NULL,            -- see the INSERTs below
  subject_type text NOT NULL,    -- 'actor' | 'token' | 'space_member' | 'workspace'
  subject_id uuid,
  space_id uuid,
  before jsonb NOT NULL,
  after jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 1. A workspace with no owner gets the earliest human admin ─────────────
-- (the old fallback made every admin the owner of such a workspace; with the
-- fallback gone it must be a stored fact). A workspace with no human stays
-- ownerless: the first person to sign in becomes the owner (trigger below).
WITH filled AS (
  UPDATE workspaces w SET owner_actor_id = (
    SELECT a.id FROM actors a
     WHERE a.workspace_id = w.id AND a.type = 'human' AND a.role = 'admin' AND a.external_id IS NOT NULL
     ORDER BY a.created_at, a.id LIMIT 1)
   WHERE w.owner_actor_id IS NULL
     AND EXISTS (SELECT 1 FROM actors a WHERE a.workspace_id = w.id AND a.type = 'human' AND a.role = 'admin' AND a.external_id IS NOT NULL)
  RETURNING w.id, w.owner_actor_id
)
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT id, 'owner_filled', 'workspace', owner_actor_id, jsonb_build_object('owner_actor_id', NULL), jsonb_build_object('owner_actor_id', owner_actor_id),
       'no owner: the earliest signed-in human admin is now the owner'
  FROM filled;

-- ── 2. Who loses review (only the owner reviews, decision 1) ───────────────
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT a.workspace_id, 'review_lost', 'actor', a.id, jsonb_build_object('role', a.role), jsonb_build_object('reviews', false),
       'could review the inbox as ' || a.role || '; now only the owner reviews'
  FROM actors a JOIN workspaces w ON w.id = a.workspace_id
 WHERE a.type = 'human' AND a.role IN ('reviewer', 'admin') AND w.owner_actor_id IS DISTINCT FROM a.id
   AND a.external_id IS DISTINCT FROM 'system';

-- ── 3. Token access (read / write) ─────────────────────────────────────────
ALTER TABLE agent_tokens ADD COLUMN access text;
UPDATE agent_tokens SET access = CASE
  WHEN allowed_tools IS NULL OR allowed_tools && ARRAY['applyTag', 'removeTag', 'updateNode', 'createNode', 'proposeTagPack', 'publishSite']::text[]
  THEN 'write' ELSE 'read' END;
-- allowed_tools is kept as stored (NULL = every tool, as before): a token is
-- never narrowed or widened by this step, and a registry that later grows does
-- not change an existing token (services/agentTools/templates.ts).
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT a.workspace_id, 'token_all_tools', 'token', t.id, jsonb_build_object('allowed_tools', NULL), jsonb_build_object('access', 'write'),
       'a token with no tool list (every tool) is now "write" and keeps every tool until the owner resets it'
  FROM agent_tokens t JOIN actors a ON a.id = t.actor_id WHERE t.allowed_tools IS NULL;
ALTER TABLE agent_tokens ALTER COLUMN access SET NOT NULL;
ALTER TABLE agent_tokens ADD CONSTRAINT agent_tokens_access_check CHECK (access IN ('read', 'write'));

-- ── 4. Tokens whose issuer was removed stay dead ───────────────────────────
-- They reach nothing today (the issuer clamp); without the clamp they would
-- come back to life.
WITH revoked AS (
  UPDATE agent_tokens SET revoked_at = now() WHERE issuer_removed_at IS NOT NULL AND revoked_at IS NULL RETURNING id, actor_id
)
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT a.workspace_id, 'token_revoked_issuer_removed', 'token', r.id, jsonb_build_object('revoked', false), jsonb_build_object('revoked', true),
       'its issuer was removed, so it reached nothing; revoked so it cannot come back'
  FROM revoked r JOIN actors a ON a.id = r.actor_id;

-- ── 5. What each live token could reach before, per space ──────────────────
-- (the legacy rule: the agent is a member, the space lets external AI in, the
-- token's list and its issuer's own spaces allow it; writing also needs the
-- editor/manager role and an editor/manager issuer.)
CREATE TEMP TABLE omm_reach AS
SELECT t.id AS token_id, t.actor_id, t.access, m.space_id, m.role,
       (s.capabilities->>'external_ai' = 'true'
        AND (t.read_space_ids IS NULL OR m.space_id = ANY(t.read_space_ids))
        AND (t.issued_by IS NULL OR EXISTS (
              SELECT 1 FROM space_members im JOIN spaces isp ON isp.id = im.space_id AND isp.deleted_at IS NULL
               WHERE im.actor_id = t.issued_by AND im.space_id = m.space_id))) AS can_read,
       (m.role IN ('editor', 'manager') AND s.capabilities->>'external_ai' = 'true'
        AND (t.write_space_ids IS NULL OR m.space_id = ANY(t.write_space_ids))
        AND (t.issued_by IS NULL OR EXISTS (
              SELECT 1 FROM space_members im JOIN spaces isp ON isp.id = im.space_id AND isp.deleted_at IS NULL
               WHERE im.actor_id = t.issued_by AND im.space_id = m.space_id AND im.role IN ('editor', 'manager')))) AS can_write
  FROM agent_tokens t
  JOIN actors a ON a.id = t.actor_id AND a.external_id IS DISTINCT FROM 'system'
  JOIN space_members m ON m.actor_id = t.actor_id
  JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
 WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now());

-- Per (agent, space): read survives only if EVERY live token read it; edit only
-- if the member role is editor/manager and EVERY write token wrote it. An agent
-- with no live token keeps its membership (no credential, nothing to widen).
CREATE TEMP TABLE omm_plan AS
SELECT actor_id, space_id, role,
       bool_and(can_read) AS keep_read,
       (role IN ('editor', 'manager') AND COALESCE(bool_and(can_write) FILTER (WHERE access = 'write'), true)) AS keep_edit
  FROM omm_reach GROUP BY actor_id, space_id, role;

INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, space_id, before, after, note)
SELECT a.workspace_id, 'agent_removed_from_space', 'space_member', p.actor_id, p.space_id,
       jsonb_build_object('role', p.role), NULL,
       'a live token of this agent could not read the space, so the agent leaves it (the owner can add it back)'
  FROM omm_plan p JOIN actors a ON a.id = p.actor_id WHERE NOT p.keep_read;

INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, space_id, before, after, note)
SELECT a.workspace_id, 'agent_edit_to_view', 'space_member', p.actor_id, p.space_id,
       jsonb_build_object('role', p.role), jsonb_build_object('permission', 'view'),
       'not every write token of this agent could write here, so it can only view (the owner can raise it)'
  FROM omm_plan p JOIN actors a ON a.id = p.actor_id
 WHERE p.keep_read AND p.role IN ('editor', 'manager') AND NOT p.keep_edit;

DELETE FROM space_members m USING omm_plan p
 WHERE m.actor_id = p.actor_id AND m.space_id = p.space_id AND NOT p.keep_read;

-- ── 6. Space permission view / edit ────────────────────────────────────────
ALTER TABLE space_members ADD COLUMN permission text;
UPDATE space_members SET permission = CASE role WHEN 'viewer' THEN 'view' ELSE 'edit' END;
UPDATE space_members m SET permission = 'view'
  FROM omm_plan p WHERE p.actor_id = m.actor_id AND p.space_id = m.space_id AND p.keep_read AND NOT p.keep_edit;

-- Non-owner managers of a shared space lose the right to manage it (decision 3).
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, space_id, before, after, note)
SELECT s.workspace_id, 'manager_to_edit', 'space_member', m.actor_id, m.space_id,
       jsonb_build_object('role', 'manager'), jsonb_build_object('permission', 'edit'),
       'managed a shared space (members, switches); now edits it, and only the owner manages'
  FROM space_members m JOIN spaces s ON s.id = m.space_id JOIN actors a ON a.id = m.actor_id
  JOIN workspaces w ON w.id = s.workspace_id
 WHERE m.role = 'manager' AND s.kind <> 'personal' AND w.owner_actor_id IS DISTINCT FROM m.actor_id
   AND a.external_id IS DISTINCT FROM 'system' AND m.permission = 'edit';

ALTER TABLE space_members ALTER COLUMN permission SET NOT NULL;
ALTER TABLE space_members ADD CONSTRAINT space_members_permission_check CHECK (permission IN ('view', 'edit'));
ALTER TABLE space_members DROP COLUMN role;  -- also drops space_members_role_check

DROP TABLE omm_plan;
DROP TABLE omm_reach;

-- ── 7. Token space lists are gone ──────────────────────────────────────────
ALTER TABLE agent_tokens DROP COLUMN read_space_ids, DROP COLUMN write_space_ids;

-- ── 8. actors.role is gone ─────────────────────────────────────────────────
-- A new member joins the default space with the permission a person without a
-- grant gets: none. The first human on an ownerless workspace becomes its
-- owner (and edits the default space); everyone has a personal space.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger AS $$
DECLARE
  personal uuid;
  became_owner boolean := false;
BEGIN
  IF NEW.type = 'human' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
    became_owner := FOUND;
  END IF;
  IF became_owner THEN
    INSERT INTO space_members (space_id, actor_id, permission)
    SELECT s.id, NEW.id, 'edit' FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), false)))
    RETURNING id INTO personal;
    INSERT INTO space_members (space_id, actor_id, permission) VALUES (personal, NEW.id, 'edit');
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

ALTER TABLE actors DROP CONSTRAINT actors_role_check;
ALTER TABLE actors DROP COLUMN role;

-- ── 9. Everyone's readable set is re-checked ───────────────────────────────
UPDATE workspaces SET membership_epoch = membership_epoch + 1;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT step, count(*) AS n FROM owner_member_migration_log GROUP BY step ORDER BY step LOOP
    RAISE NOTICE 'owner/member: % x% (see owner_member_migration_log)', r.step, r.n;
  END LOOP;
END $$;

-- ── 128_owner_guard (db/migrations/128_owner_guard.sql, appended as the snapshot convention) ──
-- 127: the workspace owner changes only through an ownership transfer
-- (docs/architecture/proposals/roles-owner-member-2026-10-22.md §3.5, decision 10).
--
-- Before: workspaces.owner_actor_id was ON DELETE SET NULL and freely updatable, so
-- a deletion path, a stray UPDATE or a future bug could leave the workspace with
-- no owner, and there was no legitimate way to hand it over.
--   * Deleting the owner's actor row is refused (RESTRICT): hand the workspace
--     over first (services/ownerTransfer.ts).
--   * Changing a SET owner is refused unless the transaction declares the new
--     owner in `onden.owner_transfer` (SET LOCAL) — which only the transfer
--     operation does. Setting the owner of an ownerless workspace (the first
--     person to sign in) is allowed; clearing it needs the declaration 'none'
--     (an operator's act; no API issues it).
--     Who may be the new owner (a person who has signed in) is the transfer
--     operation's rule, not the database's.

ALTER TABLE workspaces DROP CONSTRAINT workspaces_owner_actor_id_fkey;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_actor_id_fkey
  FOREIGN KEY (owner_actor_id) REFERENCES actors(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION workspaces_guard_owner() RETURNS trigger AS $$
DECLARE
  declared text := current_setting('onden.owner_transfer', true);
BEGIN
  IF OLD.owner_actor_id IS NULL OR NEW.owner_actor_id IS NOT DISTINCT FROM OLD.owner_actor_id THEN
    RETURN NEW;
  END IF;
  IF declared IS NOT NULL AND declared <> ''
     AND (declared = NEW.owner_actor_id::text OR (declared = 'none' AND NEW.owner_actor_id IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the workspace owner changes only through an ownership transfer'
    USING ERRCODE = 'insufficient_privilege', HINT = 'POST /api/workspace/owner-transfer';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER workspaces_guard_owner BEFORE UPDATE OF owner_actor_id ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_guard_owner();

-- ── 129_module_tags_out_of_tag_tree (db/migrations/129_module_tags_out_of_tag_tree.sql, appended as the snapshot convention) ──
-- 129: the 功能 layer takes no part in the tag tree (owner decision 2026-10-24;
-- docs/architecture/module-library.md「模型：分層的圖」, services/parentKind.ts).
-- A module tag (tag_schema->>'module') has no parent tag, and no tag sits under
-- one: a tag gets a function by extending it (tag_schema.extends), not by moving
-- under it. New writes are refused (409 module_tag_parent); this repairs rows
-- that already break the rule. Rows are never deleted; notes and field values
-- are not touched. Idempotent: a second run finds nothing to change. List the
-- affected rows first with packages/backend/scripts/module-tag-parent-rows.sql.
--
--  1. A tag directly under a module tag becomes a root tag AND extends that
--     module tag (unless it already does), so it keeps the function and its
--     fields. Its own children keep their parent (they stay under it).
--     A title already taken at the root gets " (2)", " (3)"… (the tag name
--     index is per parent).
--  2. A module tag with a parent becomes a root tag (title collisions as above).
--  3. Workspaces that changed re-check everyone's readable set (membership_epoch).

DROP TABLE IF EXISTS module_tag_parent_moves;
CREATE TEMP TABLE module_tag_parent_moves AS
WITH moving AS (
  SELECT c.id, c.workspace_id, c.title, c.created_at,
         CASE WHEN p.tag_schema->>'module' IS NOT NULL AND c.tag_schema->>'module' IS NULL
              THEN p.id END AS add_extends
    FROM content_nodes c
    JOIN content_nodes p ON p.id = c.parent_id
   WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag'
     AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL)
), ranked AS (
  SELECT m.*,
         (SELECT count(*) FROM content_nodes r
           WHERE r.workspace_id = m.workspace_id AND r.parent_id IS NULL AND r.node_type = 'class_tag'
             AND r.deleted_at IS NULL AND r.title = m.title) AS taken,
         row_number() OVER (PARTITION BY m.workspace_id, m.title ORDER BY m.created_at, m.id) AS rn
    FROM moving m
   WHERE (SELECT deleted_at FROM content_nodes WHERE id = m.id) IS NULL
)
SELECT id, workspace_id, add_extends,
       CASE WHEN taken + rn > 1 THEN title || ' (' || (taken + rn) || ')' ELSE title END AS new_title
  FROM ranked;

-- Trashed rows are re-parented too (they can come back), but they hold no name slot.
INSERT INTO module_tag_parent_moves (id, workspace_id, add_extends, new_title)
SELECT c.id, c.workspace_id,
       CASE WHEN p.tag_schema->>'module' IS NOT NULL AND c.tag_schema->>'module' IS NULL THEN p.id END,
       c.title
  FROM content_nodes c
  JOIN content_nodes p ON p.id = c.parent_id
 WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag' AND c.deleted_at IS NOT NULL
   AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL);

UPDATE content_nodes t
   SET parent_id = NULL,
       title = mv.new_title,
       tag_schema = CASE WHEN mv.add_extends IS NULL OR COALESCE(t.tag_schema->'extends', '[]'::jsonb) ? mv.add_extends::text
         THEN t.tag_schema
         ELSE jsonb_set(
           COALESCE(t.tag_schema, jsonb_build_object(
             'name', t.title, 'slug', 'module-' || t.id, 'fields', '[]'::jsonb, 'policy', '{}'::jsonb,
             'behaviour', '{}'::jsonb, 'template_children', '[]'::jsonb, 'views', '{}'::jsonb,
             'block_template', '[]'::jsonb, 'description', '', 'version', '1.0.0',
             'dependencies', '[]'::jsonb, 'publish_collection', false)),
           '{extends}',
           CASE WHEN jsonb_typeof(t.tag_schema->'extends') = 'array' THEN t.tag_schema->'extends' ELSE '[]'::jsonb END
             || to_jsonb(mv.add_extends::text)) END,
       updated_at = now()
  FROM module_tag_parent_moves mv
 WHERE t.id = mv.id;

UPDATE workspaces SET membership_epoch = membership_epoch + 1
 WHERE id IN (SELECT workspace_id FROM module_tag_parent_moves);

DROP TABLE module_tag_parent_moves;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
-- ── 131_node_event_meta (db/migrations/131_node_event_meta.sql, appended as the snapshot convention) ──
-- 130: who last touched a note, and when, kept per (note, actor) as events are appended.
--
-- Before: bootstrap computed last_actor / last_modified_at / recent_actors by
-- grouping and sorting the whole node-event log on every cold start (1.1 s at
-- 140k events, 2.6 s at 700k; docs/research/review-2026-10-24/performance.md #1).
-- The log only grows, so that cost grew with it.
--
-- Now one row per (note, actor) holds the time of that actor's latest change to
-- the note. The reader derives all three values from the few rows of a note:
-- last_actor = the actor with the newest row, last_modified_at = that time,
-- recent_actors = actors whose row is within 30 days (decided at read time, so
-- the window still moves without any job). A trigger on domain_events keeps it
-- current in the same transaction as the event, for every insert path; events
-- are append-only, so a row never needs to go back in time.
--
-- Counted as before: node events only, and not the saved-view events aimed at a
-- note (COLLECTION_VIEW_*), which are presentation, not a change to it.

CREATE TABLE node_event_meta (
  node_id text NOT NULL,
  actor_id text NOT NULL,
  last_event_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, actor_id)
);

INSERT INTO node_event_meta (node_id, actor_id, last_event_at)
SELECT target_id, actor_id, max(created_at)
  FROM domain_events
 WHERE target_type = 'node' AND event_type NOT LIKE 'COLLECTION\_VIEW\_%'
 GROUP BY target_id, actor_id;

CREATE FUNCTION node_event_meta_record() RETURNS trigger AS $$
BEGIN
  IF NEW.target_type = 'node' AND NEW.event_type NOT LIKE 'COLLECTION\_VIEW\_%' THEN
    INSERT INTO node_event_meta (node_id, actor_id, last_event_at)
    VALUES (NEW.target_id, NEW.actor_id, NEW.created_at)
    ON CONFLICT (node_id, actor_id) DO UPDATE
      SET last_event_at = GREATEST(node_event_meta.last_event_at, EXCLUDED.last_event_at);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER domain_events_node_event_meta
  AFTER INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION node_event_meta_record();

-- ── 132_snapshot_media (db/migrations/132_snapshot_media.sql, appended as the snapshot convention) ──
-- 131: which media files each publish snapshot carries, per note.
--
-- Before: an anonymous request for /api/media/<file> asked whether the served
-- site shows it by scanning the latest snapshot's whole payload (tens of MB of
-- jsonb, detoasted and lower-cased per row) once per image: ~185 ms each at 20k
-- notes (docs/research/review-2026-10-24/performance.md #5).
--
-- Now a publish records, in the transaction that inserts the snapshot, every
-- media id the snapshot's notes, collection rows and presentation name, and the
-- check is an index lookup (servedSiteShowsMedia). `kind` says where the
-- reference is: 'node' and 'item' rows name the carrying note or collection row
-- in owner_id; 'presentation' (the site settings: logo, favicon, chrome) has no
-- owner. Ids are stored lower-cased and matched whole (the media-id grammar,
-- @onden/markdown mediaRefs), where the scan matched a substring.
--
-- The backfill reads each existing snapshot once with a regex slightly looser
-- than the grammar (no look-behind in Postgres), so it can only add ids the
-- scan also matched.

CREATE TABLE snapshot_media (
  snapshot_id uuid NOT NULL REFERENCES publish_snapshots(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('node', 'item', 'presentation')),
  owner_id text NOT NULL,
  filename text NOT NULL,
  PRIMARY KEY (snapshot_id, kind, owner_id, filename)
);
CREATE INDEX snapshot_media_filename_idx ON snapshot_media (filename, snapshot_id);

INSERT INTO snapshot_media (snapshot_id, kind, owner_id, filename)
SELECT DISTINCT s.id, 'node', n->>'id', lower(m[1])
  FROM publish_snapshots s,
       jsonb_array_elements(coalesce(s.payload->'nodes', '[]'::jsonb)) n,
       regexp_matches(n::text, '/api/media/([A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)', 'g') m
 WHERE n->>'id' IS NOT NULL
UNION
SELECT DISTINCT s.id, 'item', i->>'id', lower(m[1])
  FROM publish_snapshots s,
       jsonb_array_elements(coalesce(s.payload->'collections', '[]'::jsonb)) c,
       jsonb_array_elements(coalesce(c->'items', '[]'::jsonb)) i,
       regexp_matches(i::text, '/api/media/([A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)', 'g') m
 WHERE i->>'id' IS NOT NULL
UNION
SELECT DISTINCT s.id, 'presentation', '', lower(m[1])
  FROM publish_snapshots s,
       regexp_matches(coalesce(s.payload->'presentation', '{}'::jsonb)::text, '/api/media/([A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)', 'g') m;

-- ── 134_remove_old_site (db/migrations/134_remove_old_site.sql, appended as the snapshot convention) ──
-- 134: remove the old site's data (publish redesign P5, docs/architecture/proposals/publish-redesign-2026-10-24.md).
--
-- What this DROPS, in plain words (nothing here touches a note's title or text,
-- a tag, a link, or the v2 site design; the notes of the old collections stay
-- ordinary notes):
--   1. the hosted share link's token and the learner access mode and tokens:
--      the attributes share_token, access_tokens and access_mode of the
--      site-settings note;
--   2. the old design settings on that same note: template, default_layout,
--      default_sidebar_ratio (the look now comes from the v2 design alone);
--   3. the old site design stored on the site-settings note, whenever it is not
--      v2 (the 24-block studio pages, per-page block lists): its `presentation`
--      is emptied, so the site uses the default design until the owner makes one;
--   4. the page layouts: the layout and sidebar_ratio attributes of notes
--      carrying the reserved #page tag (the tag itself stays);
--   5. the collection status of every note: its _status attribute (draft or
--      published). Collection items were ordinary notes carrying a tag; only
--      this status goes;
--   6. in every stored publish snapshot: the published collections and the old
--      design keys of its presentation (template, tokens, custom_css, site_bg,
--      blocks, pageBlocks, pageLayouts, site_pages). The page text, edges and
--      v2 design in the snapshot are kept;
--   7. the snapshot_media rows that named a collection item (kind 'item').
--
-- Attributes are deleted in 1, 2, 4 and 5, so the restore drill's attribute
-- count changes by design:
-- drill: allows attributes

-- The site-settings note: the note slugged _workspace_config that carries the
-- reserved workspace-config tag (services/siteConfig.ts getConfigNodeId).
CREATE TEMP TABLE site_config_nodes AS
SELECT n.id
  FROM content_nodes n
 WHERE n.slug = '_workspace_config'
   AND EXISTS (SELECT 1 FROM node_tags nt
                 JOIN content_nodes t ON t.id = nt.tag_id AND t.reserved_key = 'workspace-config'
                WHERE nt.node_id = n.id);

DELETE FROM node_attributes
 WHERE node_id IN (SELECT id FROM site_config_nodes)
   AND key IN ('share_token', 'access_tokens', 'access_mode', 'template', 'default_layout', 'default_sidebar_ratio');

UPDATE content_nodes
   SET presentation = NULL
 WHERE id IN (SELECT id FROM site_config_nodes)
   AND presentation IS NOT NULL
   AND (presentation->>'v') IS DISTINCT FROM '2';

DELETE FROM node_attributes a
 USING node_tags nt, content_nodes t
 WHERE a.key IN ('layout', 'sidebar_ratio')
   AND nt.node_id = a.node_id
   AND t.id = nt.tag_id
   AND t.reserved_key = 'page';

DELETE FROM node_attributes WHERE key = '_status';

UPDATE publish_snapshots
   SET payload = (payload - 'collections')
       || CASE WHEN jsonb_typeof(payload->'presentation') = 'object'
               THEN jsonb_build_object('presentation',
                      (payload->'presentation') - ARRAY['template', 'tokens', 'custom_css', 'site_bg',
                                                        'blocks', 'pageBlocks', 'pageLayouts', 'site_pages']::text[])
               ELSE '{}'::jsonb END
 WHERE payload ? 'collections'
    OR (jsonb_typeof(payload->'presentation') = 'object'
        AND (payload->'presentation') ?| ARRAY['template', 'tokens', 'custom_css', 'site_bg',
                                               'blocks', 'pageBlocks', 'pageLayouts', 'site_pages']::text[]);

DELETE FROM snapshot_media WHERE kind = 'item';
ALTER TABLE snapshot_media DROP CONSTRAINT IF EXISTS snapshot_media_kind_check;
ALTER TABLE snapshot_media ADD CONSTRAINT snapshot_media_kind_check CHECK (kind IN ('node', 'presentation'));

DROP TABLE site_config_nodes;

CREATE TABLE IF NOT EXISTS public.rss_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    -- The space that decides who reads it (same rule as a note). A deleted
    -- space leaves the row inert: it is neither listed nor fetched.
    space_id uuid NOT NULL,
    title text NOT NULL,
    -- The feed address, normalised by modules/rss/feedUrl.ts at the boundary.
    url text NOT NULL,
    created_by_actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- Conditional-GET validators and the fetch loop's own state.
    etag text,
    last_modified text,
    fetch_interval_minutes integer DEFAULT 60 NOT NULL,
    last_fetched_at timestamp with time zone,
    last_error text,
    -- The tag articles are filed under when no save default is set.
    auto_tag_id uuid,
    embed boolean DEFAULT false NOT NULL,
    -- Unseen-aging override in days; NULL = the module default.
    auto_dismiss_days integer,
    -- The feed's own save default: NULL = none set (fall back to the module
    -- default); an array (possibly empty) = explicit.
    default_tag_ids uuid[],
    default_parent_id uuid,
    always_fulltext boolean DEFAULT false NOT NULL,
    voice text DEFAULT 'media' NOT NULL,
    display_mode text DEFAULT 'text' NOT NULL,
    CONSTRAINT rss_subscriptions_voice_check CHECK (voice IN ('person', 'media')),
    CONSTRAINT rss_subscriptions_display_mode_check CHECK (display_mode IN ('text', 'image', 'video')),
    CONSTRAINT rss_subscriptions_pkey PRIMARY KEY (id),
    CONSTRAINT rss_subscriptions_interval_check CHECK (fetch_interval_minutes >= 1),
    CONSTRAINT rss_subscriptions_dismiss_check CHECK (auto_dismiss_days IS NULL OR auto_dismiss_days >= 1),
    CONSTRAINT rss_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id)
        REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT rss_subscriptions_space_id_fkey FOREIGN KEY (space_id)
        REFERENCES public.spaces(id) ON DELETE CASCADE,
    CONSTRAINT rss_subscriptions_created_by_fkey FOREIGN KEY (created_by_actor_id)
        REFERENCES public.actors(id) ON DELETE SET NULL,
    CONSTRAINT rss_subscriptions_auto_tag_fkey FOREIGN KEY (auto_tag_id)
        REFERENCES public.content_nodes(id) ON DELETE SET NULL,
    CONSTRAINT rss_subscriptions_default_parent_fkey FOREIGN KEY (default_parent_id)
        REFERENCES public.content_nodes(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.rss_subscriptions IS 'RSS subscriptions: settings, not notes (migration 145). Read under the space rule via space_id; written by modules/rss/sources.ts only.';

CREATE INDEX IF NOT EXISTS rss_subscriptions_space_idx ON public.rss_subscriptions USING btree (workspace_id, space_id);

-- 171: 少看這種 (a person's own mutes in the reader)
CREATE TABLE IF NOT EXISTS public.rss_mutes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  subscription_id uuid REFERENCES public.rss_subscriptions(id) ON DELETE CASCADE,
  keyword text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT rss_mutes_one_target CHECK ((subscription_id IS NULL) <> (keyword IS NULL)),
  CONSTRAINT rss_mutes_keyword_length CHECK (keyword IS NULL OR char_length(keyword) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS rss_mutes_actor_idx ON public.rss_mutes (workspace_id, actor_id, expires_at);

ALTER TABLE public.rss_staging ADD CONSTRAINT rss_staging_subscription_id_fkey
  FOREIGN KEY (subscription_id) REFERENCES public.rss_subscriptions(id) ON DELETE CASCADE;

-- 149: AI edits as pending suggestions (tables ai_edit_suggestions*).
--
-- AI edits as pending suggestions (docs/architecture/proposals/ai-collaboration-2026-10-27.md
-- §3.2, §4.3.1; decisions: docs/agents/decisions-ai-collaboration.md).
--
-- actors.write_mode: how an agent's edits to a note take effect. Every agent
-- that exists when this runs keeps writing directly ('apply', no change in
-- behaviour); an agent made after it starts as 'suggest' (services/actors.ts
-- createActor). The default stays 'apply' so any other way of making an actor
-- (the System actor, tests) is unchanged. Only read for type = 'agent'.
ALTER TABLE actors
  ADD COLUMN write_mode text NOT NULL DEFAULT 'apply' CHECK (write_mode IN ('suggest', 'apply'));

-- One set of suggestions an agent made for one note. base_* is what the agent
-- read: the base of the three-way merge when a person accepts (a later edit by
-- the person survives; only a real overlap makes an item stale).
CREATE TABLE ai_edit_suggestions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id         uuid NOT NULL,                 -- the note's space when proposed
  node_id          uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  agent_actor_id   uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  session_id       uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,  -- NULL: a resident (MCP) token, no session
  base_markdown    text NOT NULL,
  base_title       text NOT NULL,
  proposal_hash    text NOT NULL,                 -- sha256 of the proposed content: a retried call is the same set
  created_event_id bigint,                        -- AI_SUGGESTION_CREATED
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_edit_suggestions_node_idx ON ai_edit_suggestions (node_id, created_at DESC);
CREATE INDEX ai_edit_suggestions_session_idx ON ai_edit_suggestions (session_id) WHERE session_id IS NOT NULL;

-- One change or one comment. A paragraph is the unit: base_text and
-- base_occurrence (the n-th identical paragraph) find it again in the base
-- and in the note as it is now; a character offset would drift with edits.
-- status moves only through a guarded UPDATE ... WHERE status = 'pending'
-- (a race is decided by the database) and a final status never changes:
--   accepted / rejected  a person decided
--   stale                accept found the place changed: nothing written
--   void                 the note was deleted or moved to another space
--   replaced             the same session proposed again for this note
CREATE TABLE ai_edit_suggestion_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id    uuid NOT NULL REFERENCES ai_edit_suggestions(id) ON DELETE CASCADE,
  seq              int  NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('replace', 'insert', 'delete', 'title', 'comment')),
  base_text        text NOT NULL,                 -- the paragraph before the change; insert: the paragraph it goes after ('' = at the start)
  base_occurrence  int  NOT NULL DEFAULT 0,
  new_text         text,                          -- the change; a comment's text; NULL for delete
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'rejected', 'stale', 'void', 'replaced')),
  decided_by       uuid REFERENCES actors(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  decided_event_id bigint,                        -- AI_SUGGESTION_ACCEPTED / AI_SUGGESTION_REJECTED
  UNIQUE (suggestion_id, seq)
);
CREATE INDEX ai_edit_suggestion_items_pending_idx ON ai_edit_suggestion_items (suggestion_id) WHERE status = 'pending';

-- An @ai reply of a suggest-mode agent: kept on the session (shown beside the
-- note); writing it into the note is a person's act, which files one insert
-- suggestion (services/agentSessions.ts insertReplyAsSuggestion).
ALTER TABLE agent_sessions ADD COLUMN reply_markdown text;

-- 150: AI runtime API (ai_credentials, runtime columns).
-- 150_ai_runtime_api.sql
--
-- AI 跑法 API (docs/architecture/proposals/ai-collaboration-2026-10-27.md §3.1, §3.3, §4.2;
-- 業主 2026-10-30 同意第 9 節第 1 題：伺服器可用使用者自己的 API 金鑰呼叫模型，
-- 但工具、權限、寫入、紀錄與 MCP 同一份)。
--
-- Not done here (other batches of the proposal): renaming agent_runners to ai_roles,
-- ai_suggestions. The columns below sit on agent_runners as it is today.

-- The owner's own Anthropic API keys. Only the AES-256-GCM ciphertext is stored
-- (key: ONDEN_SECRET_KEY, a deploy environment variable — never in the database);
-- the API shows the last four characters only. A database backup holds the
-- ciphertext, so the backup and ONDEN_SECRET_KEY must be kept apart (docs/agents/deploy.md).
CREATE TABLE IF NOT EXISTS ai_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label             text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  secret_ciphertext bytea NOT NULL,
  secret_last4      text NOT NULL CHECK (char_length(secret_last4) = 4),
  created_by        uuid NOT NULL REFERENCES actors(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);
CREATE INDEX IF NOT EXISTS ai_credentials_live_idx ON ai_credentials (workspace_id) WHERE revoked_at IS NULL;

-- Per-agent API settings. There is NO default model: api_model is chosen by the
-- owner from the key's own model list. api_cap_choice records that the owner
-- answered the "monthly cap or unlimited" question the first time API was
-- switched on; an API role cannot run before it is answered.
ALTER TABLE agent_runners
  ADD COLUMN IF NOT EXISTS default_runtime         text NOT NULL DEFAULT 'subscription'
    CHECK (default_runtime IN ('api','subscription','mcp')),
  ADD COLUMN IF NOT EXISTS api_credential_id       uuid REFERENCES ai_credentials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS api_model               text,
  ADD COLUMN IF NOT EXISTS api_small_actions_only  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_web_search          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_model_retired_at   timestamptz,  -- the model's lifecycle went 'retired': the API runtime pauses until a new one is chosen
  ADD COLUMN IF NOT EXISTS api_cap_choice          text CHECK (api_cap_choice IN ('capped','unlimited')),
  ADD COLUMN IF NOT EXISTS monthly_cap_micro_usd   bigint CHECK (monthly_cap_micro_usd > 0);
ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_api_needs_key_and_model;
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_api_needs_key_and_model
  CHECK (default_runtime <> 'api' OR (api_credential_id IS NOT NULL AND api_model IS NOT NULL AND api_cap_choice IS NOT NULL));
ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_cap_matches_choice;
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_cap_matches_choice
  CHECK (api_cap_choice IS DISTINCT FROM 'capped' OR monthly_cap_micro_usd IS NOT NULL);

-- Sessions record which runtime ran them. write_mode is derived from the runtime
-- and fixed by the database: an API session is always 'suggest' (it can only
-- propose), whatever a client sends. 'apply' is today's behaviour of the
-- subscription runner and MCP, which stays as it is.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS runtime  text NOT NULL DEFAULT 'subscription' CHECK (runtime IN ('api','subscription','mcp')),
  ADD COLUMN IF NOT EXISTS kind     text NOT NULL DEFAULT 'mention' CHECK (kind IN ('mention','selection_action','panel_chat')),
  ADD COLUMN IF NOT EXISTS model    text,
  ADD COLUMN IF NOT EXISTS write_mode text NOT NULL DEFAULT 'apply' CHECK (write_mode IN ('suggest','apply')),
  ADD COLUMN IF NOT EXISTS input_tokens        bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens       bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_tokens   bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_estimate_micro_usd bigint,
  ADD COLUMN IF NOT EXISTS turns               int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skill_ref          text,   -- a selection action's built-in skill id (a note skill is skill_node_id)
  ADD COLUMN IF NOT EXISTS request_id          uuid;
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_api_suggests_only;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_api_suggests_only
  CHECK (runtime <> 'api' OR (write_mode = 'suggest' AND model IS NOT NULL));
-- A selection action has no @mention to anchor to.
ALTER TABLE agent_sessions ALTER COLUMN anchor_block_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_request_uidx
  ON agent_sessions (workspace_id, initiator_id, request_id) WHERE request_id IS NOT NULL;

ALTER TABLE agent_session_events DROP CONSTRAINT IF EXISTS agent_session_events_kind_check;
ALTER TABLE agent_session_events ADD CONSTRAINT agent_session_events_kind_check
  CHECK (kind IN ('ack','thought','action','message','error','result','read','search','usage'));

-- 151_ai_picked_skill.sql
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS picked_skill_ref    text,
  ADD COLUMN IF NOT EXISTS picked_skill_name   text,
  ADD COLUMN IF NOT EXISTS picked_skill_reason text;

-- 152_ai_runner_seen.sql
ALTER TABLE agent_runners
  ADD COLUMN IF NOT EXISTS runner_seen_at timestamptz;

-- 154_ai_panel_chat.sql
--
-- 資訊欄「AI」分頁（kind = 'panel_chat'，提案 §5.3）：一則筆記上的一段對話＝這個人在這則筆記上
-- 的 panel_chat sessions 依時間串成的序列（不另建 conversation 表）。
--   scope_node_ids / scope_tag_ids  這一則提問額外帶入的筆記與標籤（預設範圍＝本則筆記，不存）
--   chat_cleared_at                 「清除這段對話」：之後的對話不再接這些 session，列表也不顯示
-- 全部是帳務／顯示用的事實，不進事件串流、不同步。
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS scope_node_ids  uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scope_tag_ids   uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS chat_cleared_at timestamptz;
CREATE INDEX IF NOT EXISTS agent_sessions_panel_chat_idx
  ON agent_sessions (workspace_id, node_id, initiator_id, created_at)
  WHERE kind = 'panel_chat';

-- 156_ai_any_service.sql
--
-- AI 中立（業主 2026-11-01）：API 金鑰可以接任何服務。
--   • 金鑰多記「服務網址」與「格式」（/v1/messages 或 /v1/chat/completions）；選填的每百萬 token 價格由使用者自己填，
--     不再有以模型名列價的表。
--   • 月上限以 token 為準（monthly_cap_tokens）。
--
-- 既有金鑰都是第一方服務的金鑰：補上它當時固定使用的網址與格式，已存的金鑰與角色設定照樣能用。
-- 既有「有上限」的角色：舊上限是美元，無法精確換成 token；以最貴的舊價格（每百萬 token 50 美元）保守換算
-- （寧可早停，不超支），擁有者可到設定調整。

ALTER TABLE ai_credentials
  ADD COLUMN IF NOT EXISTS base_url           text,
  ADD COLUMN IF NOT EXISTS protocol           text CHECK (protocol IN ('v1_messages', 'v1_chat_completions')),
  ADD COLUMN IF NOT EXISTS price_input_per_m  numeric CHECK (price_input_per_m >= 0),
  ADD COLUMN IF NOT EXISTS price_output_per_m numeric CHECK (price_output_per_m >= 0);
UPDATE ai_credentials SET base_url = 'https://api.anthropic.com', protocol = 'v1_messages' WHERE base_url IS NULL;
ALTER TABLE ai_credentials
  ALTER COLUMN base_url SET NOT NULL,
  ALTER COLUMN protocol SET NOT NULL;
ALTER TABLE ai_credentials DROP CONSTRAINT IF EXISTS ai_credentials_prices_together;
ALTER TABLE ai_credentials ADD CONSTRAINT ai_credentials_prices_together
  CHECK ((price_input_per_m IS NULL) = (price_output_per_m IS NULL));

ALTER TABLE agent_runners ADD COLUMN IF NOT EXISTS monthly_cap_tokens bigint CHECK (monthly_cap_tokens > 0);
UPDATE agent_runners SET monthly_cap_tokens = GREATEST(1000, monthly_cap_micro_usd / 50)
 WHERE api_cap_choice = 'capped' AND monthly_cap_tokens IS NULL;
ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_cap_matches_choice;
ALTER TABLE agent_runners DROP COLUMN IF EXISTS monthly_cap_micro_usd;
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_cap_matches_choice
  CHECK (api_cap_choice IS DISTINCT FROM 'capped' OR monthly_cap_tokens IS NOT NULL);

-- 157_ai_runtime_api_or_mcp.sql
--
-- AI 角色只剩兩種跑法（業主 2026-11-01）：API（伺服器用使用者的金鑰呼叫模型）與 MCP（使用者自己的 AI 用戶端連進來，
-- 可以手動開，也可以放在某台機器上自動領排隊中的工作）。原本的「訂閱執行程式」本質上就是一個自動跑的 MCP 用戶端，併進 MCP。
--
-- 角色與 session 的 runtime 'subscription' 一律改成 'mcp'。角色金鑰、排隊中的 session、runner 的上次連線時間
-- （agent_runners.runner_seen_at）都不動；領工作的路徑（/api/mcp/sessions/pending 與 claim）不看 runtime 是哪一種，
-- 已經在跑的 runner 不用改設定。

ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_default_runtime_check;
UPDATE agent_runners SET default_runtime = 'mcp' WHERE default_runtime = 'subscription';
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_default_runtime_check CHECK (default_runtime IN ('api', 'mcp'));
ALTER TABLE agent_runners ALTER COLUMN default_runtime SET DEFAULT 'mcp';

ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_runtime_check;
UPDATE agent_sessions SET runtime = 'mcp' WHERE runtime = 'subscription';
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_runtime_check CHECK (runtime IN ('api', 'mcp'));
ALTER TABLE agent_sessions ALTER COLUMN runtime SET DEFAULT 'mcp';

-- 158_drop_age.sql
-- 158: 拿掉 Apache AGE 擴充。
--
-- 產品程式從未使用它（圖的需求用一般資料表＋WITH RECURSIVE），001 只是順手裝了。
-- 安全順序：這支遷移先上線（映像仍含 AGE，所以能 DROP），之後才換成不含 AGE 的映像。
--
-- 有 AGE 圖就停下：圖資料住在 ag_catalog 的資料表裡，DROP 會一併刪掉，這裡寧可讓遷移失敗
-- 也不刪資料；不用 CASCADE，別的東西還依賴它時 DROP 也會失敗。
-- 全新安裝（映像沒有 AGE）：沒有 ag_catalog，下面全是 no-op。
-- 查表要用 EXECUTE：寫成「表存在 AND EXISTS (SELECT … FROM 該表)」時，PL/pgSQL 會先解析整個條件，
-- 沒有 AGE 的庫（全新安裝）就因為表不存在而失敗。
DO $$
DECLARE graphs bigint;
BEGIN
  IF to_regclass('ag_catalog.ag_graph') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM ag_catalog.ag_graph' INTO graphs;
    IF graphs > 0 THEN
      RAISE EXCEPTION 'drop_age: ag_catalog.ag_graph still has graphs; refusing to drop the AGE extension. Export or remove the graphs first.';
    END IF;
  END IF;
END
$$;

-- 只在真的裝了才 DROP：伺服器若還預載 age（shared_preload_libraries）而擴充沒裝，
-- age 的掛鉤會讓 `DROP EXTENSION IF EXISTS age` 報「schema "ag_catalog" does not exist」。
-- 由 schema.sql 另外建立的 ag_catalog 不屬於擴充，DROP EXTENSION 不會帶走；
-- 不加 CASCADE：裡面還有東西就失敗，不靜默刪除。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age') THEN
    EXECUTE 'DROP EXTENSION age';
  END IF;
  IF to_regnamespace('ag_catalog') IS NOT NULL THEN
    EXECUTE 'DROP SCHEMA ag_catalog';
  END IF;
END
$$;

-- 159_ai_module.sql
--
-- AI 整個是可以關掉的模組（業主 2026-11-01）。模組 id 是 'ai'，屬於「第一次要同意」的那一類：
-- 新工作區預設關著，要擁有者同意一次才開（workspaces.modules_confirmed 裡有 'ai' 才算開）。
--
-- 更新前就已經在用 AI 的工作區（有 AI 角色、沒撤銷的 API 金鑰、或沒撤銷的 MCP 金鑰）一律記為「已同意」，
-- 這樣更新後 AI 不會突然不見。沒有的就維持關著。modules_off 不動（裡面沒有 'ai' 就是沒被擁有者關掉過）。
-- modules_confirmed 還是 NULL 的工作區不在這裡處理：開機的第一次 library 執行會用同一個判斷（modules/ai 的 inUse）補上。
-- 資料（角色、金鑰、歷史、建議）一律不動，可重複執行。

UPDATE workspaces w
   SET modules_confirmed = COALESCE(w.modules_confirmed, '[]'::jsonb) || '["ai"]'::jsonb
 WHERE w.modules_confirmed IS NOT NULL
   AND jsonb_typeof(w.modules_confirmed) = 'array'
   AND NOT (w.modules_confirmed ? 'ai')
   AND (EXISTS (SELECT 1 FROM agent_runners r WHERE r.workspace_id = w.id)
     OR EXISTS (SELECT 1 FROM ai_credentials c WHERE c.workspace_id = w.id AND c.revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM agent_tokens t JOIN actors a ON a.id = t.actor_id WHERE a.workspace_id = w.id AND t.revoked_at IS NULL));

INSERT INTO schema_migrations (version) VALUES ('001_baseline') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('002_events_retention') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('003_attribute_system') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('004_drop_node_positions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('005_site_pages_narrow_layout') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('006_collection_block_template') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('007_collection_views') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('008_supertag_substrate') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('009_workspace_config') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('010_backfill_workspace_config') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('011_drop_site_pages') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('012_tag_behaviour_policy') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('013_seed_task_tag') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('014_seed_page_tag') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('015_seed_policy') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('016_sandbox_scope_tags') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('017_agent_tokens') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('018_workspace_config_schema') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('019_node_attributes_updated_at') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('020_seed_builtin_tag_library') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('021_tag_pack_substrate') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('022_drop_dead_node_tags_rls') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('023_drop_publish_mode') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('024_open_edge_type') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('025_drop_tags_kind') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('026_template_children') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('027_note_pointers') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('028_node_block_ids') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('029_node_attributes_frontmatter_source') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('030_blob_layer') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('031_event_restore_substrate') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('032_version_event_id_wire') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('033_soft_delete_nodes') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('034_collection_views') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('035_tag_hierarchy') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('036_drop_collection_items') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('037_class_tag_node_type') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('038_tags_to_class_tag_sync_trigger') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('039_class_tag_uniqueness_drop_trigger') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('040_drop_tags_table') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('041_agent_token_scope') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('042_base_node_type') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('043_class_tag_default_base_embed') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('044_revert_base_node_type') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('045_revert_default_base_embed') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('046_outbox') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('047_remove_sandbox') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('048_actor_aware_version_throttle') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('049_node_embeddings') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('050_node_positions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('051_domain_events_append_only') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('052_append_only_by_body_hash') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('053_drop_content_node_versions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('054_event_reviews') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('055_domain_events_target_idx') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('056_schema_field_identifier_name') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('057_canvas_as_node') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('058_outbox_pending_approval') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('059_task_phase3') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('060_recur_no_zero_interval') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('061_rss_as_nodes') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('062_tasks_as_nodes') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('063_app_settings') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('064_content_nodes_slug_unique') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('064_idempotency_keys') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('065_dispatcher_pending') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('066_actor_scoped_tags') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('067_attribute_source_provenance') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('068_membership_epoch') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('069_membership_epoch_node_tag_trigger') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('070_membership_epoch_notify') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('071_actor_weak_fk') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('072_actor_weak_fk_update_guard') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('073_tag_schema_on_node_expand') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('074_tag_schema_name_slug') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('075_drop_orphan_collection_schemas') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('076_drop_collection_schemas') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('077_collection_views_on_node_expand') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('078_drop_collection_views') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('079_rate_limit_hits') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('080_rss_staging') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('081_tag_membership_state') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('082_imported_media') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('083_tag_module_bindings') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('084_member_removals') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('085_workspace_modules') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('086_canvas_module') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('090_media_uploads') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('091_block_ids_per_note') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('092_per_person_progress') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('093_spaces') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('094_spaces_on') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('095_media_owner') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('096_system_space') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('097_explicit_space_membership') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('098_token_issuer') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('099_slug_per_space') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('100_reserved_tag_keys') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('101_outbox_retry_day') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('102_token_issuer_removed') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('103_imported_media_pdf') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('104_block_nodes') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('105_attribute_value_type_repair') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('106_subscription_key_backfill') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('107_media_owner_attributes') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('109_view_modules') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('110_excalidraw_import_only') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('111_table_view_module') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('112_daily_module') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('113_view_module_tags') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('114_rss_source_marker') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('115_semantic_embed_cleanup') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('116_imported_media_all_types') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('117_drop_node_block_ids') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('118_event_redact_purged') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('119_actor_invite_email') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('120_block_review_states') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('122_block_task_lines') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('123_backup_restore_jobs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('124_actor_prefs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('125_agent_sessions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('126_drop_app_settings') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('127_owner_member') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('128_owner_guard') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('129_module_tags_out_of_tag_tree') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('130_drop_tag_membership_bump') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('131_node_event_meta') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('132_snapshot_media') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('133_modules_default_on') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('134_remove_old_site') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('135_tasks_module') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('136_history_rewind_events') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('137_workspace_time') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('138_canvas_is_a_view') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('139_fold_board_copies') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('140_system_job_no_personal_space') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('141_fold_parented_board_copy') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('142_actor_prefs_edit_time') ON CONFLICT (version) DO NOTHING;

-- Baseline data seed (migration 001's data INSERTs). A schema.sql-loaded DB
-- (fresh deploy, CI integration job) marks 001 applied WITHOUT running its
-- seeds, so without this it would lack the default workspace AND the native
-- System actor (external_id='system' — the actor resolved for sessionless /
-- native-origin requests; its absence makes those requests 401). Reconcile
-- both here, idempotently; migrate() reconciles the same rows on every boot.
INSERT INTO workspaces (name, slug) VALUES ('Onden MVP', 'default') ON CONFLICT (slug) DO NOTHING;
INSERT INTO actors (workspace_id, name, type, external_id)
SELECT id, 'System', 'agent', 'system' FROM workspaces WHERE slug = 'default'
ON CONFLICT (workspace_id, external_id) DO NOTHING;
-- Spaces (093): the default shared space and the System actor's membership.
INSERT INTO spaces (workspace_id, name, kind, is_default, capabilities)
SELECT w.id, '共用', 'shared', true, '{"publish": false, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb
  FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id AND s.is_default);
INSERT INTO space_members (space_id, actor_id, permission)
SELECT s.id, a.id, 'edit' FROM spaces s JOIN actors a ON a.workspace_id = s.workspace_id AND a.external_id = 'system'
 WHERE s.is_default ON CONFLICT (space_id, actor_id) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('143_note_block_refs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('144_remove_starter_template_children') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('145_rss_subscriptions_table') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('146_note_link_index') ON CONFLICT (version) DO NOTHING;
-- 148: focus records (the snapshot of db/migrations/148_focus_sessions.sql)
CREATE TABLE public.focus_sessions (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    task_id uuid,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT focus_sessions_note_check CHECK ((char_length(note) <= 500)),
    CONSTRAINT focus_sessions_order_chk CHECK (((ended_at IS NULL) OR (ended_at >= started_at)))
);
ALTER TABLE ONLY public.focus_sessions ADD CONSTRAINT focus_sessions_pkey PRIMARY KEY (id);
CREATE INDEX focus_sessions_actor_start_idx ON public.focus_sessions USING btree (actor_id, started_at);
CREATE UNIQUE INDEX focus_sessions_one_running_uq ON public.focus_sessions USING btree (actor_id) WHERE (ended_at IS NULL);
CREATE INDEX focus_sessions_task_idx ON public.focus_sessions USING btree (task_id) WHERE (task_id IS NOT NULL);
ALTER TABLE ONLY public.focus_sessions ADD CONSTRAINT focus_sessions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.focus_sessions ADD CONSTRAINT focus_sessions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.content_nodes(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.focus_sessions ADD CONSTRAINT focus_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
-- 153: Web Push for task reminders (the snapshot of db/migrations/153_push_subscriptions.sql)
CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_ok_at timestamp with time zone
);
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_uq UNIQUE (endpoint);
CREATE INDEX push_subscriptions_actor_idx ON public.push_subscriptions USING btree (actor_id);
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.push_subscriptions ADD CONSTRAINT push_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
-- 160: external calendars (the snapshot of db/migrations/160_external_calendars.sql)
CREATE TABLE public.external_calendars (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    url_ciphertext bytea NOT NULL,
    url_host text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_fetched_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT external_calendars_color_check CHECK ((char_length(color) <= 16)),
    CONSTRAINT external_calendars_last_error_check CHECK (((last_error IS NULL) OR (last_error = ANY (ARRAY['unreachable'::text, 'not_calendar'::text, 'too_large'::text, 'blocked'::text])))),
    CONSTRAINT external_calendars_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 60)))
);
ALTER TABLE ONLY public.external_calendars ADD CONSTRAINT external_calendars_pkey PRIMARY KEY (id);
CREATE INDEX external_calendars_actor_idx ON public.external_calendars USING btree (actor_id, created_at);
ALTER TABLE ONLY public.external_calendars ADD CONSTRAINT external_calendars_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.external_calendars ADD CONSTRAINT external_calendars_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE TABLE public.external_calendar_events (
    calendar_id uuid NOT NULL,
    instance_key text NOT NULL,
    title text NOT NULL,
    location text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    all_day boolean NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    start_date date,
    end_date date
);
ALTER TABLE ONLY public.external_calendar_events ADD CONSTRAINT external_calendar_events_pkey PRIMARY KEY (calendar_id, instance_key);
CREATE INDEX external_calendar_events_range_idx ON public.external_calendar_events USING btree (calendar_id, starts_at);
ALTER TABLE ONLY public.external_calendar_events ADD CONSTRAINT external_calendar_events_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.external_calendars(id) ON DELETE CASCADE;
CREATE TABLE public.push_reminder_sent (
    task_id uuid NOT NULL,
    moment text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.push_reminder_sent ADD CONSTRAINT push_reminder_sent_pkey PRIMARY KEY (task_id, moment);
CREATE INDEX push_reminder_sent_at_idx ON public.push_reminder_sent USING btree (sent_at);
ALTER TABLE ONLY public.push_reminder_sent ADD CONSTRAINT push_reminder_sent_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;
-- 166: 功能引用表 B1（the snapshot of db/migrations/166_function_refs.sql）
CREATE TABLE public.function_refs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    function_id text NOT NULL,
    instance text DEFAULT ''::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    holder_node_id uuid,
    holder_space_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    holder_block_id uuid,
    CONSTRAINT function_refs_config_check CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT function_refs_function_id_check CHECK (((char_length(function_id) >= 1) AND (char_length(function_id) <= 64))),
    CONSTRAINT function_refs_one_holder CHECK ((num_nonnulls(holder_node_id, holder_space_id, holder_block_id) = 1))
);
ALTER TABLE ONLY public.function_refs ADD CONSTRAINT function_refs_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX function_refs_holder_unique ON public.function_refs USING btree (COALESCE(holder_node_id, holder_space_id, holder_block_id), function_id, instance);
CREATE INDEX function_refs_function_idx ON public.function_refs USING btree (workspace_id, function_id);
CREATE INDEX function_refs_holder_block_idx ON public.function_refs USING btree (holder_block_id) WHERE (holder_block_id IS NOT NULL);
CREATE INDEX function_refs_holder_node_idx ON public.function_refs USING btree (holder_node_id) WHERE (holder_node_id IS NOT NULL);
CREATE UNIQUE INDEX function_refs_view_instance_unique ON public.function_refs USING btree (holder_node_id, instance) WHERE ((instance <> ''::text) AND (holder_node_id IS NOT NULL));
ALTER TABLE ONLY public.function_refs ADD CONSTRAINT function_refs_holder_node_id_fkey FOREIGN KEY (holder_node_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.function_refs ADD CONSTRAINT function_refs_holder_block_id_fkey FOREIGN KEY (holder_block_id) REFERENCES public.block_nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.function_refs ADD CONSTRAINT function_refs_holder_space_id_fkey FOREIGN KEY (holder_space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.function_refs ADD CONSTRAINT function_refs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
INSERT INTO schema_migrations (version) VALUES ('147_tasks_into_notes') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('148_focus_sessions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('149_ai_suggestions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('150_ai_runtime_api') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('151_ai_picked_skill') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('152_ai_runner_seen') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('153_push_subscriptions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('154_ai_panel_chat') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('155_remove_publish_site_effect') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('156_ai_any_service') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('157_ai_runtime_api_or_mcp') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('158_drop_age') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('159_ai_module') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('160_external_calendars') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('161_block_anchors') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('162_event_body_hash_base') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('164_block_link_bindings') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('166_function_refs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('172_board_ink_attribute') ON CONFLICT (version) DO NOTHING;
-- 173: distributed sync (the snapshot of db/migrations/173_distributed_sync.sql)

CREATE TABLE IF NOT EXISTS ds_node (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  node_id text NOT NULL,
  hlc_wall bigint NOT NULL DEFAULT 0,
  hlc_counter integer NOT NULL DEFAULT 0,
  next_seq bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ds_ops (
  op_id text PRIMARY KEY,
  origin_node text NOT NULL,
  origin_seq bigint NOT NULL CHECK (origin_seq >= 1),
  hlc_wall bigint NOT NULL,
  hlc_counter integer NOT NULL,
  author_actor text NOT NULL,
  space_id text NOT NULL,
  kind text NOT NULL,
  body jsonb NOT NULL,
  received_from text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ds_ops_id_matches CHECK (op_id = origin_node || ':' || origin_seq::text),
  CONSTRAINT ds_ops_origin_seq_uq UNIQUE (origin_node, origin_seq)
);
CREATE INDEX IF NOT EXISTS ds_ops_order_idx ON ds_ops (hlc_wall, hlc_counter, origin_node, origin_seq);
CREATE INDEX IF NOT EXISTS ds_ops_space_idx ON ds_ops (space_id);

CREATE OR REPLACE FUNCTION ds_ops_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ds_ops is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER ds_ops_no_update BEFORE UPDATE ON ds_ops FOR EACH ROW EXECUTE FUNCTION ds_ops_append_only();
CREATE OR REPLACE TRIGGER ds_ops_no_delete BEFORE DELETE ON ds_ops FOR EACH ROW EXECUTE FUNCTION ds_ops_append_only();

CREATE TABLE IF NOT EXISTS ds_rejections (
  id bigserial PRIMARY KEY,
  op_id text,
  from_node text NOT NULL,
  reason text NOT NULL,
  op jsonb,
  rejected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ds_peers (
  node_id text PRIMARY KEY,
  actors text[] NOT NULL,
  paired_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('173_distributed_sync') ON CONFLICT (version) DO NOTHING;
-- 174: distributed sync bridge (the snapshot of db/migrations/174_distributed_sync_bridge.sql)


CREATE TABLE IF NOT EXISTS ds_capture_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_event_id bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ds_captured_events (
  event_id bigint PRIMARY KEY,
  op_count integer NOT NULL CHECK (op_count >= 0),
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ds_unsupported (
  event_type text PRIMARY KEY,
  event_count bigint NOT NULL DEFAULT 0,
  first_event_id bigint NOT NULL,
  last_event_id bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS ds_projection_failures (
  id bigserial PRIMARY KEY,
  op_id text,
  note_id text,
  step text NOT NULL,
  reason text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE space_members DROP CONSTRAINT IF EXISTS space_members_permission_check;
ALTER TABLE space_members ADD CONSTRAINT space_members_permission_check CHECK (permission IN ('view', 'suggest', 'edit'));
INSERT INTO schema_migrations (version) VALUES ('174_distributed_sync_bridge') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('177_backup_restore_workspace_mode') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('178_retire_shutdown_prefs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('179_decide_ambiguous_board_ink') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('181_rss_voice_and_display') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('182_rss_mutes') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('183_review_states_one_table') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('184_rolled_from_index') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('185_drop_tag_is_inheritable') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('186_publish_by_space') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('187_domain_events_device_id') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('188_views_into_function_refs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('190_sync_stamps') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('191_tasks_into_function_refs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('192_remove_read_later') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('194_stamps_s2') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('193_remove_citations_module') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('195_review_into_function_refs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('196_remove_module_tags') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('198_stamps_s4') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('199_stamps_s3') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('200_order_keys') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('201_derived_ids_function_ref_stamps') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('202_stamps_genesis') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('203_ink_chunks') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('204_stamped_snapshot_join') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('205_stamp_saw_heads') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('206_sync_change_bundles') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('207_fresh_proofs') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('209_place_is_one_write') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('210_participant_sessions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('212_idempotency_event_position') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('213_renew_node_id') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('214_sync_join_source_former') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('215_block_anchors_replicated') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('217_keep_session_actor_rows') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('218_space_follows_tree') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('219_sign_in_rows_for_better_auth_1_7') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('220_note_versions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('221_merge_core_before_transport') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('222_sync_join_source_brought') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('224_sync_restore_kept_node_id') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('225_analyze_note_versions') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('226_stamp_triggers_use_the_key') ON CONFLICT (version) DO NOTHING;

--
-- Name: block_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_anchors (
    workspace_id uuid NOT NULL,
    anchor_id text NOT NULL,
    note_id uuid NOT NULL,
    kind text DEFAULT 'block'::text NOT NULL,
    from_utf16 integer NOT NULL,
    to_utf16 integer NOT NULL,
    at_body_hash text NOT NULL,
    quote text NOT NULL,
    quote_prefix text DEFAULT ''::text NOT NULL,
    quote_suffix text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'valid'::text NOT NULL,
    candidate_from_utf16 integer,
    candidate_to_utf16 integer,
    recovery_pending boolean DEFAULT false NOT NULL,
    alias_of text,
    moved_how text DEFAULT 'created'::text NOT NULL,
    moved_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT block_anchors_anchor_id_check CHECK ((anchor_id ~ '^[a-zA-Z0-9-]{1,64}$'::text)),
    CONSTRAINT block_anchors_kind_check CHECK ((kind = ANY (ARRAY['block'::text, 'range'::text]))),
    CONSTRAINT block_anchors_moved_how_check CHECK ((moved_how = ANY (ARRAY['created'::text, 'editor'::text, 'diff'::text, 'found'::text, 'confirmed'::text, 'unchanged'::text]))),
    CONSTRAINT block_anchors_status_check CHECK ((status = ANY (ARRAY['valid'::text, 'maybe'::text, 'lost'::text]))),
    CONSTRAINT block_anchors_from_utf16_check CHECK ((from_utf16 >= 0)),
    CONSTRAINT block_anchors_check CHECK ((to_utf16 >= from_utf16)),
    PRIMARY KEY (workspace_id, anchor_id),
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (note_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE
);

CREATE INDEX block_anchors_note_idx ON public.block_anchors USING btree (note_id);

-- 163: block nodes know their anchor and can stand alone as a note.
ALTER TABLE public.block_nodes ADD COLUMN IF NOT EXISTS anchor_id text;
ALTER TABLE public.block_nodes ADD COLUMN IF NOT EXISTS detached_note_id uuid REFERENCES public.content_nodes(id) ON DELETE SET NULL;
ALTER TABLE public.block_nodes ADD COLUMN IF NOT EXISTS detached_tags text[];
CREATE UNIQUE INDEX IF NOT EXISTS block_nodes_anchor_uq ON public.block_nodes (workspace_id, anchor_id) WHERE anchor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS block_nodes_detached_uq ON public.block_nodes (detached_note_id) WHERE detached_note_id IS NOT NULL;
INSERT INTO schema_migrations (version) VALUES ('163_block_node_anchor_detach') ON CONFLICT (version) DO NOTHING;
--
-- Name: block_link_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_link_bindings (
    workspace_id uuid NOT NULL,
    note_id uuid NOT NULL,
    link_text text NOT NULL,
    anchor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT block_link_bindings_link_text_check CHECK (((char_length(link_text) >= 1) AND (char_length(link_text) <= 400))),
    CONSTRAINT block_link_bindings_anchor_id_check CHECK ((anchor_id ~ '^[a-zA-Z0-9-]{1,64}$'::text)),
    PRIMARY KEY (workspace_id, note_id, link_text),
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (note_id) REFERENCES public.content_nodes(id) ON DELETE CASCADE
);

CREATE INDEX block_link_bindings_anchor_idx ON public.block_link_bindings USING btree (workspace_id, anchor_id);

-- 180: progress of moving block identity out of the text (0 = may carry `^id` marks, 1 = converted or new, 2 = left as is).
ALTER TABLE public.content_nodes ADD COLUMN IF NOT EXISTS anchor_form smallint NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS content_nodes_anchor_form_idx ON public.content_nodes (workspace_id) WHERE anchor_form = 0;
INSERT INTO schema_migrations (version) VALUES ('180_block_anchor_form') ON CONFLICT (version) DO NOTHING;

-- 190: write stamps and the structure change log (db/migrations/190_sync_stamps.sql)
CREATE TABLE IF NOT EXISTS sync_node (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  node_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_clock (
  workspace_id uuid PRIMARY KEY,
  next_seq bigint NOT NULL DEFAULT 1,
  hlc_wall bigint NOT NULL DEFAULT 0,
  hlc_counter integer NOT NULL DEFAULT 0,
  writes_without_mutate bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_stamps (
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_key text NOT NULL,
  field text NOT NULL,
  origin text NOT NULL,
  seq bigint NOT NULL,
  hlc_wall bigint NOT NULL,
  hlc_counter integer NOT NULL,
  author text,
  device uuid,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, table_name, row_key, field)
);

CREATE TABLE IF NOT EXISTS structure_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_key text NOT NULL,
  field text NOT NULL,
  old_value text,
  new_value text,
  origin text NOT NULL,
  seq bigint NOT NULL,
  hlc_wall bigint NOT NULL,
  hlc_counter integer NOT NULL,
  author text,
  device uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS structure_log_row_idx ON structure_log (workspace_id, table_name, row_key, id);

CREATE OR REPLACE FUNCTION structure_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'structure_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER structure_log_no_update BEFORE UPDATE ON structure_log FOR EACH ROW EXECUTE FUNCTION structure_log_append_only();
CREATE OR REPLACE TRIGGER structure_log_no_delete BEFORE DELETE ON structure_log FOR EACH ROW EXECUTE FUNCTION structure_log_append_only();

-- Lock the workspace's clock row (making it, and the node row, the first time) and say what it holds. The workspace's
-- event-append lock comes first, the same key as spine/eventLock.ts, so every path takes the two locks in one order.
CREATE OR REPLACE FUNCTION sync_lock_clock(p_ws uuid) RETURNS TABLE (node_id text, next_seq bigint, hlc_wall bigint, hlc_counter integer) AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('event-append:' || p_ws::text));
  INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text) ON CONFLICT (singleton) DO NOTHING;
  INSERT INTO sync_clock (workspace_id) VALUES (p_ws) ON CONFLICT (workspace_id) DO NOTHING;
  RETURN QUERY SELECT n.node_id, c.next_seq, c.hlc_wall, c.hlc_counter
                 FROM sync_clock c, sync_node n WHERE c.workspace_id = p_ws AND n.singleton FOR UPDATE OF c;
END;
$$ LANGUAGE plpgsql;

-- The stamp for a write that did not come through spine/mutate: same clock rule as src/hlc.ts tick()
-- (src/test/syncStamps.integration.test.ts checks the two agree). This is the database's own clock, spine/stamps.ts
-- reads the application's: on purpose, the clock rule (the larger of the two wins, else the counter goes up) takes
-- whichever is ahead, so a difference between the two machines' clocks never makes a stamp go backwards.
CREATE OR REPLACE FUNCTION sync_allocate_stamp(p_ws uuid) RETURNS jsonb AS $$
DECLARE
  c record;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  new_wall bigint;
  new_counter integer;
BEGIN
  SELECT * INTO c FROM sync_lock_clock(p_ws);
  IF now_ms > c.hlc_wall THEN new_wall := now_ms; new_counter := 0;
  ELSE new_wall := c.hlc_wall; new_counter := c.hlc_counter + 1; END IF;
  UPDATE sync_clock SET next_seq = c.next_seq + 1, hlc_wall = new_wall, hlc_counter = new_counter,
                        writes_without_mutate = writes_without_mutate + 1 WHERE workspace_id = p_ws;
  RETURN jsonb_build_object('origin', c.node_id, 'seq', c.next_seq, 'wall', new_wall, 'counter', new_counter, 'bypass', true);
END;
$$ LANGUAGE plpgsql;

-- The setting that carries a workspace's stamp through the transaction.
CREATE OR REPLACE FUNCTION sync_stamp_setting(p_ws uuid) RETURNS text AS $$
  SELECT 'onden.stamp_' || replace(p_ws::text, '-', '_');
$$ LANGUAGE sql IMMUTABLE;

-- The workspace's stamp in this transaction: the one spine/stamps.ts set, or a new one (author NULL) made now and kept
-- for the rest of the transaction.
CREATE OR REPLACE FUNCTION sync_stamp_current(p_ws uuid) RETURNS jsonb AS $$
DECLARE s jsonb := NULLIF(current_setting(sync_stamp_setting(p_ws), true), '')::jsonb;
BEGIN
  IF s IS NULL THEN
    s := sync_allocate_stamp(p_ws);
    PERFORM set_config(sync_stamp_setting(p_ws), s::text, true);
  END IF;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_stamp_put(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb) RETURNS void AS $$
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
  VALUES (p_ws, p_table, p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted;
$$ LANGUAGE sql;

-- A column of the row being changed, as text (NULL when the column is). Read one column at a time with dynamic SQL, not by
-- turning the whole row into jsonb: a note's body is large, and copying it twice on every title edit was the cost.
CREATE OR REPLACE FUNCTION sync_column(r anyelement, p_column text) RETURNS text AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT ($1).%I::text', p_column) INTO v USING r;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- Did the column change? The field named 'deleted' counts only whether the column is set, the rest compare the value.
CREATE OR REPLACE FUNCTION sync_column_changed(o anyelement, n anyelement, p_field text, p_column text) RETURNS boolean AS $$
DECLARE changed boolean;
BEGIN
  IF p_field = 'deleted' THEN
    EXECUTE format('SELECT (($1).%1$I IS NULL) IS DISTINCT FROM (($2).%1$I IS NULL)', p_column) INTO changed USING o, n;
  ELSE
    EXECUTE format('SELECT ($1).%1$I IS DISTINCT FROM ($2).%1$I', p_column) INTO changed USING o, n;
  END IF;
  RETURN changed;
END;
$$ LANGUAGE plpgsql;

-- The value as logged in structure_log: 'true' / 'false' for the deleted state, the column's text otherwise.
CREATE OR REPLACE FUNCTION sync_logged_value(r anyelement, p_field text, p_column text) RETURNS text AS $$
  SELECT CASE WHEN p_field = 'deleted' THEN (sync_column(r, p_column) IS NOT NULL)::text ELSE sync_column(r, p_column) END;
$$ LANGUAGE sql;

-- Arguments: table label, key column, workspace column, tracked fields 'field=column,...' (each gets its own stamp when
-- it changes), structure fields 'field=column,...' (each gets an old -> new row in structure_log, or '').
CREATE OR REPLACE FUNCTION sync_stamp_trigger() RETURNS trigger AS $$
DECLARE
  tbl text := TG_ARGV[0];
  ws uuid;
  key text;
  s jsonb;
  spec text;
  fld text;
  col text;
  ov text;
  nv text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ws := sync_column(OLD, TG_ARGV[2])::uuid; key := sync_column(OLD, TG_ARGV[1]);
  ELSE
    ws := sync_column(NEW, TG_ARGV[2])::uuid; key := sync_column(NEW, TG_ARGV[1]);
  END IF;
  s := sync_stamp_current(ws);

  IF TG_OP = 'INSERT' THEN
    PERFORM sync_stamp_put(ws, tbl, key, '*', false, s);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = tbl AND row_key = key AND field <> '*';
    PERFORM sync_stamp_put(ws, tbl, key, '*', true, s);
  ELSE
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[3], ',') LOOP
      fld := split_part(spec, '=', 1);
      col := split_part(spec, '=', 2);
      IF sync_column_changed(OLD, NEW, fld, col) THEN
        PERFORM sync_stamp_put(ws, tbl, key, fld, false, s);
      END IF;
    END LOOP;
  END IF;

  IF TG_ARGV[4] <> '' THEN
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[4], ',') LOOP
      fld := split_part(spec, '=', 1);
      col := split_part(spec, '=', 2);
      -- A created row logs every field; a purged row logs only that it is gone (new value NULL).
      IF TG_OP = 'DELETE' THEN
        IF fld <> 'deleted' THEN CONTINUE; END IF;
        ov := sync_logged_value(OLD, fld, col); nv := NULL;
      ELSIF TG_OP = 'INSERT' THEN
        ov := NULL; nv := sync_logged_value(NEW, fld, col);
      ELSE
        IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
        ov := sync_logged_value(OLD, fld, col); nv := sync_logged_value(NEW, fld, col);
      END IF;
      INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value,
                                 origin, seq, hlc_wall, hlc_counter, author, device)
      VALUES (ws, tbl, key, fld, ov, nv,
              s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
              s->>'author', NULLIF(s->>'device', '')::uuid);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- content_nodes: the whole row, plus title, body, parent, sort order, hidden, space and deleted state each on their own.
-- Parent, space and deleted state are also logged in structure_log; sort order is not (proposal §8.5).
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=sort_order,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_update AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown
     OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.sort_order IS DISTINCT FROM NEW.sort_order
     OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=sort_order,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=sort_order,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,space=space_id,deleted=deleted_at');

-- 194: write stamps for attributes, tags, hand-made edges, pointers and board cards (db/migrations/194_stamps_s2.sql)
CREATE OR REPLACE FUNCTION derive_row_id(p_kind text, VARIADIC p_parts text[]) RETURNS uuid AS $$
  SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    FROM (SELECT encode(sha256(convert_to(p_kind || E'\x1f' || array_to_string(p_parts, E'\x1f'), 'UTF8')), 'hex') AS h) x;
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION note_pointer_derive_id() RETURNS trigger AS $$
BEGIN
  NEW.id := derive_row_id('note_pointer', COALESCE(NEW.parent_id::text, ''), NEW.target_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE moved bigint; extra bigint;
BEGIN
  -- A row that already holds the derived id ranks first, so running this again picks the same row as the first run did,
  -- whatever created_at the rows tie on (otherwise the second run could try to give the derived id to a different row).
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY parent_id, target_id
             ORDER BY (id = derive_row_id('note_pointer', COALESCE(parent_id::text, ''), target_id::text)) DESC, created_at, id) AS rn
      FROM note_pointers),
  moving AS (
    UPDATE note_pointers p SET id = derive_row_id('note_pointer', COALESCE(p.parent_id::text, ''), p.target_id::text)
      FROM ranked r WHERE r.id = p.id AND r.rn = 1
       AND p.id <> derive_row_id('note_pointer', COALESCE(p.parent_id::text, ''), p.target_id::text)
    RETURNING 1)
  SELECT count(*) INTO moved FROM moving;
  SELECT count(*) INTO extra FROM note_pointers p
   WHERE p.id <> derive_row_id('note_pointer', COALESCE(p.parent_id::text, ''), p.target_id::text);
  RAISE NOTICE '194: % pointer id(s) replaced by a derived id; % extra top-level duplicate(s) keep their old id', moved, extra;
END $$;

CREATE OR REPLACE TRIGGER note_pointers_derive_id BEFORE INSERT ON note_pointers FOR EACH ROW EXECUTE FUNCTION note_pointer_derive_id();


CREATE OR REPLACE FUNCTION structure_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('onden.structure_merge', true) = 'on'
     AND NEW.id = OLD.id AND NEW.workspace_id = OLD.workspace_id AND NEW.table_name = OLD.table_name
     AND NEW.row_key = OLD.row_key AND NEW.field = OLD.field AND NEW.old_value IS NOT DISTINCT FROM OLD.old_value THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'structure_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_workspace(r anyelement, p_arg text) RETURNS uuid AS $$
DECLARE c text; w uuid;
BEGIN
  IF left(p_arg, 4) <> 'via:' THEN RETURN sync_column(r, p_arg)::uuid; END IF;
  FOREACH c IN ARRAY string_to_array(substr(p_arg, 5), ',') LOOP
    EXECUTE format('SELECT n.workspace_id FROM content_nodes n WHERE n.id = ($1).%I', c) INTO w USING r;
    IF w IS NOT NULL THEN RETURN w; END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_key(r anyelement, p_columns text) RETURNS text AS $$
DECLARE c text; k text := NULL;
BEGIN
  FOREACH c IN ARRAY string_to_array(p_columns, ',') LOOP
    k := CASE WHEN k IS NULL THEN sync_column(r, c) ELSE k || '/' || sync_column(r, c) END;
  END LOOP;
  RETURN k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_composite(r anyelement, p_columns text) RETURNS text AS $$
DECLARE c text; args text := ''; v text;
BEGIN
  FOREACH c IN ARRAY string_to_array(p_columns, '+') LOOP
    args := args || CASE WHEN args = '' THEN '' ELSE ', ' END || format('%L, ($1).%I', c, c);
  END LOOP;
  EXECUTE 'SELECT jsonb_build_object(' || args || ')::text' INTO v USING r;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_column_changed(o anyelement, n anyelement, p_field text, p_column text) RETURNS boolean AS $$
DECLARE changed boolean; c text;
BEGIN
  IF p_field = 'deleted' THEN
    EXECUTE format('SELECT (($1).%1$I IS NULL) IS DISTINCT FROM (($2).%1$I IS NULL)', p_column) INTO changed USING o, n;
    RETURN changed;
  END IF;
  FOREACH c IN ARRAY string_to_array(p_column, '+') LOOP
    EXECUTE format('SELECT ($1).%1$I IS DISTINCT FROM ($2).%1$I', c) INTO changed USING o, n;
    IF changed THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_logged_value(r anyelement, p_field text, p_column text) RETURNS text AS $$
  SELECT CASE WHEN p_field = 'deleted' THEN (sync_column(r, p_column) IS NOT NULL)::text
              WHEN position('+' IN p_column) > 0 THEN sync_composite(r, p_column)
              ELSE sync_column(r, p_column) END;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION sync_structure_put(p_ws uuid, p_table text, p_key text, p_field text, p_old text, p_new text, s jsonb, p_merge boolean) RETURNS void AS $$
DECLARE prev record;
BEGIN
  IF p_merge THEN
    SELECT id, old_value, new_value, author, device, at INTO prev FROM structure_log
     WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field ORDER BY id DESC LIMIT 1;
    IF FOUND AND prev.new_value IS NOT DISTINCT FROM p_old AND prev.new_value IS NOT NULL
       AND prev.author IS NOT DISTINCT FROM (s->>'author') AND prev.device IS NOT DISTINCT FROM NULLIF(s->>'device', '')::uuid
       AND prev.at > clock_timestamp() - interval '5 seconds' THEN
      PERFORM set_config('onden.structure_merge', 'on', true);
      UPDATE structure_log SET new_value = p_new, origin = s->>'origin', seq = (s->>'seq')::bigint,
             hlc_wall = (s->>'wall')::bigint, hlc_counter = (s->>'counter')::int, at = clock_timestamp()
       WHERE id = prev.id;
      PERFORM set_config('onden.structure_merge', '', true);
      RETURN;
    END IF;
  END IF;
  INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value,
                             origin, seq, hlc_wall, hlc_counter, author, device)
  VALUES (p_ws, p_table, p_key, p_field, p_old, p_new,
          s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_stamp_trigger() RETURNS trigger AS $$
DECLARE
  tbl text := TG_ARGV[0];
  op text := TG_OP;
  mode text := COALESCE(TG_ARGV[6], '');
  ws uuid;
  key text;
  skey text;
  s jsonb;
  spec text;
  fld text;
  col text;
  kind text;
  ov text;
  nv text;
  cut int;
  filt text := COALESCE(TG_ARGV[7], '');
  keep boolean := true;
BEGIN
  IF mode = 'asdelete' THEN op := 'DELETE'; ELSIF mode = 'asinsert' THEN op := 'INSERT'; END IF;
  IF op = 'DELETE' THEN
    ws := sync_workspace(OLD, TG_ARGV[2]); key := sync_key(OLD, TG_ARGV[1]);
    skey := sync_key(OLD, COALESCE(NULLIF(TG_ARGV[5], ''), TG_ARGV[1]));
  ELSE
    ws := sync_workspace(NEW, TG_ARGV[2]); key := sync_key(NEW, TG_ARGV[1]);
    skey := sync_key(NEW, COALESCE(NULLIF(TG_ARGV[5], ''), TG_ARGV[1]));
  END IF;
  IF ws IS NULL THEN RETURN NULL; END IF; -- the notes this row belongs to are already gone: their own tombstone says so
  s := sync_stamp_current(ws);
  IF filt <> '' THEN
    IF op = 'DELETE' THEN keep := sync_column(OLD, split_part(filt, '=', 1)) IS NOT DISTINCT FROM split_part(filt, '=', 2);
    ELSE keep := sync_column(NEW, split_part(filt, '=', 1)) IS NOT DISTINCT FROM split_part(filt, '=', 2); END IF;
  END IF;

  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put(ws, tbl, key, '*', false, s);
  ELSIF op = 'DELETE' THEN
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = tbl AND row_key = key AND field <> '*';
    PERFORM sync_stamp_put(ws, tbl, key, '*', true, s);
  ELSE
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[3], ',') LOOP
      fld := split_part(spec, '=', 1);
      col := split_part(spec, '=', 2);
      IF sync_column_changed(OLD, NEW, fld, col) THEN
        PERFORM sync_stamp_put(ws, tbl, key, fld, false, s);
      END IF;
    END LOOP;
  END IF;

  IF TG_ARGV[4] <> '' AND keep THEN
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[4], ',') LOOP
      cut := least(NULLIF(position('=' IN spec), 0), NULLIF(position('~' IN spec), 0), NULLIF(position('@' IN spec), 0), NULLIF(position('^' IN spec), 0));
      fld := left(spec, cut - 1); kind := substr(spec, cut, 1); col := substr(spec, cut + 1);
      IF kind = '=' THEN
        -- A created row logs every field; a purged row logs only that it is gone (new value NULL).
        IF op = 'DELETE' THEN
          IF fld <> 'deleted' THEN CONTINUE; END IF;
          ov := sync_logged_value(OLD, fld, col); nv := NULL;
        ELSIF op = 'INSERT' THEN
          ov := NULL; nv := sync_logged_value(NEW, fld, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_logged_value(OLD, fld, col); nv := sync_logged_value(NEW, fld, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSIF kind = '~' THEN
        IF op = 'UPDATE' THEN CONTINUE; END IF;
        IF op = 'DELETE' THEN ov := sync_column(OLD, col); nv := NULL; ELSE ov := NULL; nv := sync_column(NEW, col); END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSIF kind = '^' THEN
        IF op = 'DELETE' THEN ov := sync_column(OLD, col); nv := NULL;
        ELSIF op = 'INSERT' THEN ov := NULL; nv := sync_column(NEW, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_column(OLD, col); nv := sync_column(NEW, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSE -- '@'
        IF op = 'DELETE' THEN ov := sync_composite(OLD, col); nv := NULL;
        ELSIF op = 'INSERT' THEN ov := NULL; nv := sync_composite(NEW, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_composite(OLD, col); nv := sync_composite(NEW, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, op = 'UPDATE');
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sync_stamp_attribute_trigger() RETURNS trigger AS $$
DECLARE
  old_kept boolean := false;
  new_kept boolean := false;
  op text;
  ws uuid;
  rkey text;
  attr text;
  s jsonb;
  value_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_kept := OLD.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF TG_OP <> 'DELETE' THEN new_kept := NEW.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF NOT old_kept AND NOT new_kept THEN RETURN NULL; END IF;
  -- what this change is to the stamps: a source flip counts as made / removed
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND old_kept AND NOT new_kept) THEN op := 'DELETE';
  ELSIF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NOT old_kept AND new_kept) THEN op := 'INSERT';
  ELSE op := 'UPDATE'; END IF;
  IF op = 'DELETE' THEN
    ws := OLD.workspace_id; rkey := OLD.node_id::text || '/' || OLD.key; attr := OLD.key;
  ELSE
    ws := NEW.workspace_id; rkey := NEW.node_id::text || '/' || NEW.key; attr := NEW.key;
  END IF;
  IF op = 'UPDATE' THEN
    value_changed := OLD.value IS DISTINCT FROM NEW.value;
    IF NOT (value_changed OR OLD.value_type IS DISTINCT FROM NEW.value_type OR OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable) THEN
      RETURN NULL;
    END IF;
  END IF;
  s := sync_stamp_current(ws);
  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', false, s);
    IF attr = '_canvas_sections' THEN PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', NULL, NEW.value, s, false); END IF;
  ELSIF op = 'DELETE' THEN
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', true, s);
    IF attr = '_canvas_sections' THEN PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false); END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'value', false, s); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'type', false, s); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'inheritable', false, s); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false); END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER node_attributes_sync_stamp_insert AFTER INSERT ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_attribute_trigger();
CREATE OR REPLACE TRIGGER node_attributes_sync_stamp_update AFTER UPDATE ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_attribute_trigger();
CREATE OR REPLACE TRIGGER node_attributes_sync_stamp_delete AFTER DELETE ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_attribute_trigger();

CREATE OR REPLACE TRIGGER node_tags_sync_stamp_insert AFTER INSERT ON node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_tags', 'node_id,tag_id', 'via:node_id,tag_id', '', 'tag~tag_id', 'node_id', '');
CREATE OR REPLACE TRIGGER node_tags_sync_stamp_delete AFTER DELETE ON node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_tags', 'node_id,tag_id', 'via:node_id,tag_id', '', 'tag~tag_id', 'node_id', '');

CREATE OR REPLACE TRIGGER block_node_tags_sync_stamp_insert AFTER INSERT ON block_node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_node_tags', 'block_node_id,tag_id', 'workspace_id', '', '', '', '');
CREATE OR REPLACE TRIGGER block_node_tags_sync_stamp_delete AFTER DELETE ON block_node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_node_tags', 'block_node_id,tag_id', 'workspace_id', '', '', '', '');

CREATE OR REPLACE TRIGGER node_edges_sync_stamp_insert AFTER INSERT ON node_edges FOR EACH ROW WHEN (NEW.origin = 'manual')
  EXECUTE FUNCTION sync_stamp_trigger('node_edges', 'source_node_id,target_node_id,edge_type', 'workspace_id', 'status=status', '', '', '');
CREATE OR REPLACE TRIGGER node_edges_sync_stamp_update AFTER UPDATE ON node_edges FOR EACH ROW
  WHEN (OLD.origin = 'manual' AND NEW.origin = 'manual' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_stamp_trigger('node_edges', 'source_node_id,target_node_id,edge_type', 'workspace_id', 'status=status', '', '', '');
CREATE OR REPLACE TRIGGER node_edges_sync_stamp_delete AFTER DELETE ON node_edges FOR EACH ROW WHEN (OLD.origin = 'manual')
  EXECUTE FUNCTION sync_stamp_trigger('node_edges', 'source_node_id,target_node_id,edge_type', 'workspace_id', 'status=status', '', '', '');

CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_insert AFTER INSERT ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=sort_order,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_update AFTER UPDATE ON note_pointers FOR EACH ROW
  WHEN (OLD.sort_order IS DISTINCT FROM NEW.sort_order OR OLD.display_prefix IS DISTINCT FROM NEW.display_prefix)
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=sort_order,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_delete AFTER DELETE ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=sort_order,prefix=display_prefix', '', '', '');

CREATE OR REPLACE TRIGGER node_positions_sync_stamp_insert AFTER INSERT ON node_positions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_positions', 'node_id,surface', 'workspace_id',
    'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', 'card@x+y+width+height+color+folded+sub_canvas_id', '', '');
CREATE OR REPLACE TRIGGER node_positions_sync_stamp_update AFTER UPDATE ON node_positions FOR EACH ROW
  WHEN (OLD.x IS DISTINCT FROM NEW.x OR OLD.y IS DISTINCT FROM NEW.y OR OLD.width IS DISTINCT FROM NEW.width
     OR OLD.height IS DISTINCT FROM NEW.height OR OLD.color IS DISTINCT FROM NEW.color OR OLD.folded IS DISTINCT FROM NEW.folded
     OR OLD.sub_canvas_id IS DISTINCT FROM NEW.sub_canvas_id)
  EXECUTE FUNCTION sync_stamp_trigger('node_positions', 'node_id,surface', 'workspace_id',
    'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', 'card@x+y+width+height+color+folded+sub_canvas_id', '', '');
CREATE OR REPLACE TRIGGER node_positions_sync_stamp_delete AFTER DELETE ON node_positions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_positions', 'node_id,surface', 'workspace_id',
    'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', 'card@x+y+width+height+color+folded+sub_canvas_id', '', '');

-- 198: write stamps on personal settings (db/migrations/198_stamps_s4.sql)
CREATE OR REPLACE TRIGGER rss_mutes_sync_stamp_insert AFTER INSERT ON rss_mutes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_mutes', 'id', 'workspace_id', 'keyword=keyword,source=subscription_id,expires=expires_at', '');
CREATE OR REPLACE TRIGGER rss_mutes_sync_stamp_update AFTER UPDATE ON rss_mutes FOR EACH ROW
  WHEN (OLD.keyword IS DISTINCT FROM NEW.keyword OR OLD.subscription_id IS DISTINCT FROM NEW.subscription_id
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
  EXECUTE FUNCTION sync_stamp_trigger('rss_mutes', 'id', 'workspace_id', 'keyword=keyword,source=subscription_id,expires=expires_at', '');
CREATE OR REPLACE TRIGGER rss_mutes_sync_stamp_delete AFTER DELETE ON rss_mutes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_mutes', 'id', 'workspace_id', 'keyword=keyword,source=subscription_id,expires=expires_at', '');

CREATE OR REPLACE TRIGGER rss_subscriptions_sync_stamp_insert AFTER INSERT ON rss_subscriptions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_subscriptions', 'id', 'workspace_id',
    'title=title,url=url,space=space_id,interval=fetch_interval_minutes,auto_tag=auto_tag_id,embed=embed,dismiss=auto_dismiss_days,default_tags=default_tag_ids,default_parent=default_parent_id,fulltext=always_fulltext,voice=voice,display=display_mode', '');
CREATE OR REPLACE TRIGGER rss_subscriptions_sync_stamp_update AFTER UPDATE ON rss_subscriptions FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.url IS DISTINCT FROM NEW.url OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR OLD.fetch_interval_minutes IS DISTINCT FROM NEW.fetch_interval_minutes OR OLD.auto_tag_id IS DISTINCT FROM NEW.auto_tag_id
     OR OLD.embed IS DISTINCT FROM NEW.embed OR OLD.auto_dismiss_days IS DISTINCT FROM NEW.auto_dismiss_days
     OR OLD.default_tag_ids IS DISTINCT FROM NEW.default_tag_ids OR OLD.default_parent_id IS DISTINCT FROM NEW.default_parent_id
     OR OLD.always_fulltext IS DISTINCT FROM NEW.always_fulltext OR OLD.voice IS DISTINCT FROM NEW.voice
     OR OLD.display_mode IS DISTINCT FROM NEW.display_mode)
  EXECUTE FUNCTION sync_stamp_trigger('rss_subscriptions', 'id', 'workspace_id',
    'title=title,url=url,space=space_id,interval=fetch_interval_minutes,auto_tag=auto_tag_id,embed=embed,dismiss=auto_dismiss_days,default_tags=default_tag_ids,default_parent=default_parent_id,fulltext=always_fulltext,voice=voice,display=display_mode', '');
CREATE OR REPLACE TRIGGER rss_subscriptions_sync_stamp_delete AFTER DELETE ON rss_subscriptions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_subscriptions', 'id', 'workspace_id',
    'title=title,url=url,space=space_id,interval=fetch_interval_minutes,auto_tag=auto_tag_id,embed=embed,dismiss=auto_dismiss_days,default_tags=default_tag_ids,default_parent=default_parent_id,fulltext=always_fulltext,voice=voice,display=display_mode', '');

CREATE OR REPLACE TRIGGER external_calendars_sync_stamp_insert AFTER INSERT ON external_calendars FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('external_calendars', 'id', 'workspace_id', 'name=name,color=color,enabled=enabled', '');
CREATE OR REPLACE TRIGGER external_calendars_sync_stamp_update AFTER UPDATE ON external_calendars FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.color IS DISTINCT FROM NEW.color OR OLD.enabled IS DISTINCT FROM NEW.enabled)
  EXECUTE FUNCTION sync_stamp_trigger('external_calendars', 'id', 'workspace_id', 'name=name,color=color,enabled=enabled', '');
CREATE OR REPLACE TRIGGER external_calendars_sync_stamp_delete AFTER DELETE ON external_calendars FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('external_calendars', 'id', 'workspace_id', 'name=name,color=color,enabled=enabled', '');

CREATE OR REPLACE TRIGGER actor_module_settings_sync_stamp_insert AFTER INSERT ON actor_module_settings FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('actor_module_settings', 'actor_id,tag_id', 'via:tag_id', 'settings=settings', '');
CREATE OR REPLACE TRIGGER actor_module_settings_sync_stamp_update AFTER UPDATE ON actor_module_settings FOR EACH ROW
  WHEN (OLD.settings IS DISTINCT FROM NEW.settings)
  EXECUTE FUNCTION sync_stamp_trigger('actor_module_settings', 'actor_id,tag_id', 'via:tag_id', 'settings=settings', '');
CREATE OR REPLACE TRIGGER actor_module_settings_sync_stamp_delete AFTER DELETE ON actor_module_settings FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('actor_module_settings', 'actor_id,tag_id', 'via:tag_id', 'settings=settings', '');

-- 199: write stamps for the keys inside JSON columns, spaces, space members and workspace settings (db/migrations/199_stamps_s3.sql)
-- ---------------------------------------------------------------------------------------------------------------------
-- helpers

-- A column of the row being changed as jsonb (NULL when the column is NULL); one column at a time, like sync_column().
CREATE OR REPLACE FUNCTION sync_column_jsonb(r anyelement, p_column text) RETURNS jsonb AS $$
DECLARE v jsonb;
BEGIN
  EXECUTE format('SELECT ($1).%I::jsonb', p_column) INTO v USING r;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- Text to jsonb, NULL when it is not JSON (a section-frame attribute is free text in a text column).
CREATE OR REPLACE FUNCTION sync_text_jsonb(p text) RETURNS jsonb AS $$
BEGIN
  RETURN p::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The units of a JSON value, by shape (see the header). Anything that is not the shape's container has no units.
CREATE OR REPLACE FUNCTION sync_json_units(p jsonb, p_shape text) RETURNS TABLE (k text, v jsonb) AS $$
  SELECT x.key, x.value FROM jsonb_each(CASE WHEN p_shape = 'object' AND jsonb_typeof(p) = 'object' THEN p ELSE '{}'::jsonb END) x
  UNION ALL
  SELECT e->>'id', e FROM jsonb_array_elements(CASE WHEN p_shape = 'array' AND jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) e
   WHERE jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'id') = 'string'
  UNION ALL
  SELECT e #>> '{}', e FROM jsonb_array_elements(CASE WHEN p_shape = 'set' AND jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) e
   WHERE jsonb_typeof(e) = 'string';
$$ LANGUAGE sql IMMUTABLE;

-- Stamp the units that differ between p_old and p_new (NULL = the value does not exist). p_log_table <> '' also writes one
-- structure_log row per changed unit (field p_log_prefix || key, old and new as JSON text, NULL when the unit is absent).
-- The workspace's stamp is taken only when something changed.
CREATE OR REPLACE FUNCTION sync_stamp_json_diff(p_ws uuid, p_label text, p_row text, p_shape text, p_prefix text,
                                                p_log_table text, p_log_prefix text, p_old jsonb, p_new jsonb) RETURNS void AS $$
DECLARE
  u record;
  s jsonb;
BEGIN
  FOR u IN
    SELECT coalesce(o.k, n.k) AS k, o.v AS old_v, n.v AS new_v
      FROM sync_json_units(p_old, p_shape) o FULL JOIN sync_json_units(p_new, p_shape) n ON o.k = n.k
     WHERE o.v IS DISTINCT FROM n.v
  LOOP
    IF s IS NULL THEN s := sync_stamp_current(p_ws); END IF;
    PERFORM sync_stamp_put(p_ws, p_label, p_row, p_prefix || u.k, u.new_v IS NULL, s);
    IF p_log_table <> '' THEN
      PERFORM sync_structure_put(p_ws, p_log_table, p_row, p_log_prefix || u.k, u.old_v::text, u.new_v::text, s, false);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Arguments: 0 stamp table label; 1 row key column; 2 workspace column, 'via:' or 'space:'; 3 the jsonb column; 4 shape
-- ('object' | 'array' | 'set'); 5 unit prefix of the stamp field; 6 structure_log table ('' = none); 7 its field prefix.
CREATE OR REPLACE FUNCTION sync_stamp_json_trigger() RETURNS trigger AS $$
DECLARE
  o jsonb;
  n jsonb;
  ws uuid;
  rkey text;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := sync_column_jsonb(OLD, TG_ARGV[3]); END IF;
  IF TG_OP <> 'DELETE' THEN n := sync_column_jsonb(NEW, TG_ARGV[3]); END IF;
  IF o IS NOT DISTINCT FROM n THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN ws := sync_workspace(OLD, TG_ARGV[2]); rkey := sync_column(OLD, TG_ARGV[1]);
  ELSE ws := sync_workspace(NEW, TG_ARGV[2]); rkey := sync_column(NEW, TG_ARGV[1]); END IF;
  IF ws IS NULL THEN RETURN NULL; END IF; -- the workspace is already gone
  PERFORM sync_stamp_json_diff(ws, TG_ARGV[0], rkey, TG_ARGV[4], TG_ARGV[5], TG_ARGV[6], TG_ARGV[7], o, n);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The row's workspace, now also 'space:col' = the workspace of the space that column names (space_members has no workspace
-- column; while a space is purged its members are already gone, so a missing space means the rows go with the workspace).
CREATE OR REPLACE FUNCTION sync_workspace(r anyelement, p_arg text) RETURNS uuid AS $$
DECLARE c text; w uuid;
BEGIN
  IF left(p_arg, 6) = 'space:' THEN
    EXECUTE format('SELECT s.workspace_id FROM spaces s WHERE s.id = ($1).%I', substr(p_arg, 7)) INTO w USING r;
    RETURN w;
  END IF;
  IF left(p_arg, 4) <> 'via:' THEN RETURN sync_column(r, p_arg)::uuid; END IF;
  FOREACH c IN ARRAY string_to_array(substr(p_arg, 5), ',') LOOP
    EXECUTE format('SELECT n.workspace_id FROM content_nodes n WHERE n.id = ($1).%I', c) INTO w USING r;
    IF w IS NOT NULL THEN RETURN w; END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------------------------------
-- JSON columns of content_nodes

CREATE OR REPLACE TRIGGER content_nodes_collection_views_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  WHEN (NEW.collection_views IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.collection_views', 'id', 'workspace_id', 'collection_views', 'array', 'view:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_collection_views_stamp_update AFTER UPDATE OF collection_views ON content_nodes FOR EACH ROW
  WHEN (OLD.collection_views IS DISTINCT FROM NEW.collection_views)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.collection_views', 'id', 'workspace_id', 'collection_views', 'array', 'view:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_collection_views_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  WHEN (OLD.collection_views IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.collection_views', 'id', 'workspace_id', 'collection_views', 'array', 'view:', '', '');

CREATE OR REPLACE TRIGGER content_nodes_tag_schema_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  WHEN (NEW.tag_schema IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.tag_schema', 'id', 'workspace_id', 'tag_schema', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_tag_schema_stamp_update AFTER UPDATE OF tag_schema ON content_nodes FOR EACH ROW
  WHEN (OLD.tag_schema IS DISTINCT FROM NEW.tag_schema)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.tag_schema', 'id', 'workspace_id', 'tag_schema', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_tag_schema_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  WHEN (OLD.tag_schema IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.tag_schema', 'id', 'workspace_id', 'tag_schema', 'object', 'key:', '', '');

-- ---------------------------------------------------------------------------------------------------------------------
-- spaces and their members

CREATE OR REPLACE TRIGGER spaces_sync_stamp_insert AFTER INSERT ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_update AFTER UPDATE OF name, kind, owner_actor_id, deleted_at ON spaces FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_delete AFTER DELETE ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=deleted_at', '', '', '');

-- A space that is really deleted takes its members with it (ON DELETE CASCADE), but by then the space row is gone and the
-- members' stamp trigger can no longer find the workspace, so their tombstones and "removed" log lines would be lost and the old
-- member stamps would stay as if the members were still there. Deleting the members first, while the space can still be seen,
-- gives each the same tombstone and log line as any other removal. (Same transaction, same result as the cascade.)
CREATE OR REPLACE FUNCTION spaces_remove_members_first() RETURNS trigger AS $$
BEGIN
  DELETE FROM space_members WHERE space_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER spaces_remove_members_first BEFORE DELETE ON spaces FOR EACH ROW EXECUTE FUNCTION spaces_remove_members_first();

CREATE OR REPLACE TRIGGER spaces_capabilities_stamp_insert AFTER INSERT ON spaces FOR EACH ROW
  WHEN (NEW.capabilities <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('spaces.capabilities', 'id', 'workspace_id', 'capabilities', 'object', 'switch:', 'spaces', 'capability:');
CREATE OR REPLACE TRIGGER spaces_capabilities_stamp_update AFTER UPDATE OF capabilities ON spaces FOR EACH ROW
  WHEN (OLD.capabilities IS DISTINCT FROM NEW.capabilities)
  EXECUTE FUNCTION sync_stamp_json_trigger('spaces.capabilities', 'id', 'workspace_id', 'capabilities', 'object', 'switch:', 'spaces', 'capability:');
CREATE OR REPLACE TRIGGER spaces_capabilities_stamp_delete AFTER DELETE ON spaces FOR EACH ROW
  WHEN (OLD.capabilities <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('spaces.capabilities', 'id', 'workspace_id', 'capabilities', 'object', 'switch:', 'spaces', 'capability:');

-- space_members: keyed by (space, member); the permission is its own stamp and its own structure_log line.
CREATE OR REPLACE TRIGGER space_members_sync_stamp_insert AFTER INSERT ON space_members FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('space_members', 'space_id,actor_id', 'space:space_id', 'permission=permission', 'permission^permission', '', '');
CREATE OR REPLACE TRIGGER space_members_sync_stamp_update AFTER UPDATE OF permission ON space_members FOR EACH ROW
  WHEN (OLD.permission IS DISTINCT FROM NEW.permission)
  EXECUTE FUNCTION sync_stamp_trigger('space_members', 'space_id,actor_id', 'space:space_id', 'permission=permission', 'permission^permission', '', '');
CREATE OR REPLACE TRIGGER space_members_sync_stamp_delete AFTER DELETE ON space_members FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('space_members', 'space_id,actor_id', 'space:space_id', 'permission=permission', 'permission^permission', '', '');

-- ---------------------------------------------------------------------------------------------------------------------
-- workspace settings: time zone and day-change hour on their own; each module switch (modules_off: the module is off;
-- modules_confirmed: the owner agreed to it) is one unit, so turning a module on again is a tombstone of "off:<module>".
-- Not on membership_epoch (it changes on every membership change) or the rest of the row.

CREATE OR REPLACE TRIGGER workspaces_sync_stamp_insert AFTER INSERT ON workspaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('workspaces', 'id', 'id', 'time_zone=time_zone,day_start=day_start_hour', '', '', '');
CREATE OR REPLACE TRIGGER workspaces_sync_stamp_update AFTER UPDATE OF time_zone, day_start_hour ON workspaces FOR EACH ROW
  WHEN (OLD.time_zone IS DISTINCT FROM NEW.time_zone OR OLD.day_start_hour IS DISTINCT FROM NEW.day_start_hour)
  EXECUTE FUNCTION sync_stamp_trigger('workspaces', 'id', 'id', 'time_zone=time_zone,day_start=day_start_hour', '', '', '');

CREATE OR REPLACE TRIGGER workspaces_modules_off_stamp_insert AFTER INSERT ON workspaces FOR EACH ROW
  WHEN (NEW.modules_off <> '[]'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_off', 'id', 'id', 'modules_off', 'set', 'off:', '', '');
CREATE OR REPLACE TRIGGER workspaces_modules_off_stamp_update AFTER UPDATE OF modules_off ON workspaces FOR EACH ROW
  WHEN (OLD.modules_off IS DISTINCT FROM NEW.modules_off)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_off', 'id', 'id', 'modules_off', 'set', 'off:', '', '');
CREATE OR REPLACE TRIGGER workspaces_modules_confirmed_stamp_insert AFTER INSERT ON workspaces FOR EACH ROW
  WHEN (NEW.modules_confirmed IS NOT NULL AND NEW.modules_confirmed <> '[]'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_confirmed', 'id', 'id', 'modules_confirmed', 'set', 'confirmed:', '', '');
CREATE OR REPLACE TRIGGER workspaces_modules_confirmed_stamp_update AFTER UPDATE OF modules_confirmed ON workspaces FOR EACH ROW
  WHEN (OLD.modules_confirmed IS DISTINCT FROM NEW.modules_confirmed)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_confirmed', 'id', 'id', 'modules_confirmed', 'set', 'confirmed:', '', '');

-- ---------------------------------------------------------------------------------------------------------------------
-- a board's section frames: S2's function (194) with the per-section stamps added; everything else in it is unchanged.

CREATE OR REPLACE FUNCTION sync_stamp_attribute_trigger() RETURNS trigger AS $$
DECLARE
  old_kept boolean := false;
  new_kept boolean := false;
  op text;
  ws uuid;
  rkey text;
  attr text;
  s jsonb;
  value_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_kept := OLD.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF TG_OP <> 'DELETE' THEN new_kept := NEW.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF NOT old_kept AND NOT new_kept THEN RETURN NULL; END IF;
  -- what this change is to the stamps: a source flip counts as made / removed
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND old_kept AND NOT new_kept) THEN op := 'DELETE';
  ELSIF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NOT old_kept AND new_kept) THEN op := 'INSERT';
  ELSE op := 'UPDATE'; END IF;
  IF op = 'DELETE' THEN
    ws := OLD.workspace_id; rkey := OLD.node_id::text || '/' || OLD.key; attr := OLD.key;
  ELSE
    ws := NEW.workspace_id; rkey := NEW.node_id::text || '/' || NEW.key; attr := NEW.key;
  END IF;
  IF op = 'UPDATE' THEN
    value_changed := OLD.value IS DISTINCT FROM NEW.value;
    IF NOT (value_changed OR OLD.value_type IS DISTINCT FROM NEW.value_type OR OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable) THEN
      RETURN NULL;
    END IF;
  END IF;
  s := sync_stamp_current(ws);
  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', false, s);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', NULL, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', NULL, sync_text_jsonb(NEW.value));
    END IF;
  ELSIF op = 'DELETE' THEN
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', true, s);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', OLD.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), NULL);
    END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'value', false, s); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'type', false, s); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'inheritable', false, s); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), sync_text_jsonb(NEW.value));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 200: same-level order keys (db/migrations/200_order_keys.sql); the columns are in the tables above
CREATE INDEX IF NOT EXISTS content_nodes_order_idx ON content_nodes (workspace_id, parent_id, order_key) WHERE deleted_at IS NULL;

-- order_stamp: the stamp of the write that set the key, copied by the database itself (the same stamp the stamp trigger
-- puts in sync_stamps, a foreign node's stamp when one is being adopted), so the tie rule is an ordinary ORDER BY and
-- travels with the row to every node.
CREATE OR REPLACE FUNCTION order_stamp_set() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.order_key IS DISTINCT FROM OLD.order_key THEN
    s := sync_stamp_current(NEW.workspace_id);
    NEW.order_stamp := lpad(s->>'wall', 15, '0') || lpad(s->>'counter', 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER content_nodes_order_stamp BEFORE INSERT OR UPDATE OF order_key ON content_nodes
  FOR EACH ROW EXECUTE FUNCTION order_stamp_set();
CREATE OR REPLACE TRIGGER note_pointers_order_stamp BEFORE INSERT OR UPDATE OF order_key ON note_pointers
  FOR EACH ROW EXECUTE FUNCTION order_stamp_set();

-- The stamp triggers watch order_key now; the stamp field keeps its name, 'sort'.
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_update AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown
     OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.order_key IS DISTINCT FROM NEW.order_key
     OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');

-- note_pointers: the arguments of 194 with the order column swapped.
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_insert AFTER INSERT ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=order_key,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_update AFTER UPDATE ON note_pointers FOR EACH ROW
  WHEN (OLD.order_key IS DISTINCT FROM NEW.order_key OR OLD.display_prefix IS DISTINCT FROM NEW.display_prefix)
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=order_key,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_delete AFTER DELETE ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=order_key,prefix=display_prefix', '', '', '');
-- 201: derived ids for what Onden makes by itself, function_refs write stamps (db/migrations/201_derived_ids_function_ref_stamps.sql; the id rewrite of existing rows is data, not schema)
-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The id derivation, in SQL (the TypeScript side is utils.ts uuidV5; src/test checks the two agree).

CREATE OR REPLACE FUNCTION onden_uuid5(p_ns uuid, p_name text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(
    set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid
  FROM (SELECT substring(public.digest(decode(replace(p_ns::text, '-', ''), 'hex') || convert_to(p_name, 'UTF8'), 'sha1') from 1 for 16) AS h) x
$$;

-- The id for a space made by the database: the derived one, or a random one when another space already has it (a deleted
-- personal space of the same person, say), so making a space never fails on the derivation.
CREATE OR REPLACE FUNCTION onden_space_id(p_name text) RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM spaces WHERE id = onden_uuid5('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', p_name))
              THEN gen_random_uuid()
              ELSE onden_uuid5('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', p_name) END
$$;

CREATE OR REPLACE FUNCTION workspaces_default_space() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO spaces (id, workspace_id, name, kind, is_default, capabilities)
  VALUES (onden_space_id('default-space/' || NEW.id), NEW.id, '共用', 'shared', true,
          '{"publish": false, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

-- 127's function with one change: the personal space is made with its derived id, and a second maker (another transaction,
-- another device after a merge) ends with the same row instead of a second one.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger AS $$
DECLARE
  personal uuid;
  became_owner boolean := false;
BEGIN
  IF NEW.type = 'human' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
    became_owner := FOUND;
  END IF;
  IF became_owner THEN
    INSERT INTO space_members (space_id, actor_id, permission)
    SELECT s.id, NEW.id, 'edit' FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    personal := onden_space_id('personal-space/' || NEW.workspace_id || '/' || NEW.id);
    INSERT INTO spaces (id, workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (personal, NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), false)))
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO space_members (space_id, actor_id, permission) VALUES (personal, NEW.id, 'edit')
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. function_refs write stamps (S1 pattern: generic trigger; 199 pattern: config per key). Created BEFORE the rewrite below,
-- whose user-trigger switch-off then covers them too (the rewrite is not an edit).

CREATE OR REPLACE TRIGGER function_refs_sync_stamp_insert AFTER INSERT ON function_refs FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('function_refs', 'id', 'workspace_id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', '');
CREATE OR REPLACE TRIGGER function_refs_sync_stamp_update AFTER UPDATE ON function_refs FOR EACH ROW
  WHEN (OLD.function_id IS DISTINCT FROM NEW.function_id OR OLD.instance IS DISTINCT FROM NEW.instance
     OR OLD.holder_node_id IS DISTINCT FROM NEW.holder_node_id OR OLD.holder_space_id IS DISTINCT FROM NEW.holder_space_id)
  EXECUTE FUNCTION sync_stamp_trigger('function_refs', 'id', 'workspace_id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', '');
CREATE OR REPLACE TRIGGER function_refs_sync_stamp_delete AFTER DELETE ON function_refs FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('function_refs', 'id', 'workspace_id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', '');

CREATE OR REPLACE TRIGGER function_refs_config_stamp_insert AFTER INSERT ON function_refs FOR EACH ROW
  WHEN (NEW.config <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('function_refs.config', 'id', 'workspace_id', 'config', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER function_refs_config_stamp_update AFTER UPDATE OF config ON function_refs FOR EACH ROW
  WHEN (OLD.config IS DISTINCT FROM NEW.config)
  EXECUTE FUNCTION sync_stamp_json_trigger('function_refs.config', 'id', 'workspace_id', 'config', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER function_refs_config_stamp_delete AFTER DELETE ON function_refs FOR EACH ROW
  WHEN (OLD.config <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('function_refs.config', 'id', 'workspace_id', 'config', 'object', 'key:', '', '');

-- The old -> new id of every row this migration changed, kept so that history written before it still means something: events
-- are append-only and keep the old id, and restoring one (services/idRewrites.ts, read by eventRestore) follows it to the new one.
CREATE TABLE IF NOT EXISTS id_rewrites (
  old_id uuid PRIMARY KEY,
  new_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  rewritten_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS id_rewrites_workspace_idx ON id_rewrites (workspace_id);
-- 202: genesis stamps and the structure baseline (db/migrations/202_stamps_genesis.sql; the stamps and baseline lines it adds are data, the function is schema:
-- a later migration that wires up another table ends with SELECT * FROM sync_genesis_pass(), also on a database made from this file)
-- The pass is a function so a later migration that wires up another table or column ends with one line: SELECT * FROM sync_genesis_pass().
-- It is idempotent and returns what it added. A stamp is added only where the unit has none (ON CONFLICT DO NOTHING). A baseline is taken
-- per workspace, table and field kind: a marker line (table_name 'baseline', row_key = the table, field = the unit kind) says "this
-- workspace's baseline of this unit kind is taken", so a table or column wired up later gets its baseline on the next call, and the
-- ones already taken are not repeated. Rows it cannot place (no workspace found, or a NULL in the key) are counted in rows_skipped and
-- reported with a NOTICE; the preview lists them by table.
-- A write that runs while this is open: stamps are unique by (workspace, table, row, field), so a writer's trigger on the same key waits
-- for this transaction and then replaces the genesis stamp (DO UPDATE), and a genesis stamp is never written over a stamp that is there
-- (DO NOTHING). structure_log has no unique key: a baseline line records the value as this statement saw it (READ COMMITTED), and a
-- concurrent writer that committed in between has its own line with a real stamp; a reader takes, per unit, the line with the greatest
-- clock (genesis is 0/0, so it never beats a real line), so the baseline can only be the oldest line of a unit, whatever its id says.
-- The preview in the header does not call this function (it has to run before it exists).
CREATE OR REPLACE FUNCTION sync_genesis_pass() RETURNS TABLE (stamps_added bigint, baseline_lines_added bigint, markers_added bigint, rows_skipped bigint) AS $fn$
DECLARE
  v_step record;
  v_added bigint;
  v_skipped bigint;
  v_stamps bigint := 0;
  v_lines bigint := 0;
  v_skips bigint := 0;
  v_marks jsonb := '[]'::jsonb;
  v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE NOT t.tgisinternal AND p.proname LIKE 'sync\_%trigger'
                AND p.proname NOT IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')) THEN
    RAISE EXCEPTION '202 (sync_genesis_pass): a stamp trigger function this migration does not know is installed; extend the plan before running it';
  END IF;

  FOR v_step IN
    WITH trg AS (
      SELECT c.relname::text AS tbl, p.proname::text AS fn,
             string_to_array(encode(t.tgargs, 'escape'), '\000') AS a,
             (regexp_match(pg_get_triggerdef(t.oid), ' WHEN \((.*)\) EXECUTE FUNCTION '))[1] AS wh
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND pg_table_is_visible(c.oid)
         AND (t.tgtype & 5) = 5 AND (t.tgtype & 2) = 0
         AND p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')
    ),
    g AS (
      SELECT trg.*,
             CASE WHEN a[3] LIKE 'via:%'
                    THEN 'COALESCE(' || (SELECT string_agg(format('(SELECT n.workspace_id FROM content_nodes n WHERE n.id = t.%I)', c), ', ' ORDER BY o)
                                           FROM unnest(string_to_array(substr(a[3], 5), ',')) WITH ORDINALITY AS u(c, o)) || ')'
                  WHEN a[3] LIKE 'space:%' THEN format('(SELECT s.workspace_id FROM spaces s WHERE s.id = t.%I)', substr(a[3], 7))
                  ELSE format('t.%I', a[3]) END AS ws_sql,
             (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
                FROM unnest(string_to_array(a[2], ',')) WITH ORDINALITY AS u(c, o)) AS key_sql,
             (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
                FROM unnest(string_to_array(COALESCE(NULLIF(a[6], ''), a[2]), ',')) WITH ORDINALITY AS u(c, o)) AS log_key_sql,
             COALESCE(regexp_replace(wh, '\mnew\.', 't.', 'gi'), 'true') AS when_sql,
             CASE WHEN COALESCE(a[8], '') = '' THEN 'true'
                  ELSE format('t.%I::text IS NOT DISTINCT FROM %L', split_part(a[8], '=', 1), split_part(a[8], '=', 2)) END AS filter_sql
        FROM trg WHERE fn <> 'sync_stamp_attribute_trigger'
    ),
    fields AS (
      SELECT g.*, left(x.spec, x.cut - 1) AS fld, substr(x.spec, x.cut, 1) AS kind, substr(x.spec, x.cut + 1) AS col
        FROM g
       CROSS JOIN LATERAL (SELECT s.spec, least(NULLIF(position('=' IN s.spec), 0), NULLIF(position('~' IN s.spec), 0),
                                                NULLIF(position('@' IN s.spec), 0), NULLIF(position('^' IN s.spec), 0)) AS cut
                             FROM unnest(string_to_array(g.a[5], ',')) AS s(spec)) x
       WHERE g.fn = 'sync_stamp_trigger' AND COALESCE(g.a[5], '') <> ''
    ),
    plan AS (
      SELECT 'stamps' AS part, a[1] AS table_name, 'row' AS unit,
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, NULL::text AS nv FROM %I t WHERE %s',
                    ws_sql, a[1], key_sql, '*', tbl, when_sql) AS src_sql
        FROM g WHERE fn = 'sync_stamp_trigger'
      UNION ALL
      SELECT 'stamps', a[1], a[6] || '*',
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, NULL::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
                    ws_sql, a[1], key_sql, a[6], tbl, a[4], a[5], when_sql)
        FROM g WHERE fn = 'sync_stamp_json_trigger'
      UNION ALL
      SELECT 'stamps', 'node_attributes', 'row (a person or automation wrote it)',
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''*'' AS fld, NULL::text AS nv FROM node_attributes t WHERE t.source IN (''ui'', ''explicit'', ''dispatcher'')'
        FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
      UNION ALL
      SELECT 'stamps', 'node_attributes._canvas_sections', 'section:*',
             'SELECT t.workspace_id AS ws, ''node_attributes._canvas_sections'' AS tn, t.node_id::text AS rk, ''section:'' || u.k AS fld, NULL::text AS nv FROM node_attributes t CROSS JOIN LATERAL sync_json_units(sync_text_jsonb(t.value), ''array'') u WHERE t.key = ''_canvas_sections'' AND t.source IN (''ui'', ''explicit'', ''dispatcher'')'
        FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
      UNION ALL
      SELECT 'structure baseline', a[1], fld,
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, %s AS nv FROM %I t WHERE %s AND %s',
                    ws_sql, a[1], log_key_sql, fld,
                    CASE WHEN kind = '=' AND fld = 'deleted' THEN format('(t.%I IS NOT NULL)::text', col)
                         WHEN kind = '@' OR (kind = '=' AND position('+' IN col) > 0)
                           THEN 'jsonb_build_object(' || (SELECT string_agg(format('%L, t.%I', c, c), ', ' ORDER BY o)
                                                            FROM unnest(string_to_array(col, '+')) WITH ORDINALITY AS u(c, o)) || ')::text'
                         ELSE format('t.%I::text', col) END,
                    tbl, when_sql, filter_sql)
        FROM fields
      UNION ALL
      SELECT 'structure baseline', a[7], a[8] || '*',
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, u.v::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
                    ws_sql, a[7], key_sql, a[8], tbl, a[4], a[5], when_sql)
        FROM g WHERE fn = 'sync_stamp_json_trigger' AND COALESCE(a[7], '') <> ''
      UNION ALL
      SELECT 'structure baseline', 'node_attributes', 'sections',
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''sections'' AS fld, t.value AS nv FROM node_attributes t WHERE t.key = ''_canvas_sections'' AND t.source IN (''ui'', ''explicit'', ''dispatcher'')'
        FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
    )
    SELECT DISTINCT part, table_name, unit, src_sql FROM plan ORDER BY part, table_name, unit
  LOOP
    IF v_step.part = 'stamps' THEN
      EXECUTE format('WITH u AS MATERIALIZED (%s),
                           ins AS (INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
                                   SELECT u.ws, u.tn, u.rk, u.fld, ''genesis'', 0, 0, 0, NULL, NULL, false FROM u
                                    WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL
                                   ON CONFLICT (workspace_id, table_name, row_key, field) DO NOTHING RETURNING 1)
                      SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM u WHERE u.ws IS NULL OR u.rk IS NULL)', v_step.src_sql)
        INTO v_added, v_skipped;
      v_stamps := v_stamps + v_added;
    ELSE
      v_marks := v_marks || jsonb_build_array(jsonb_build_array(v_step.table_name, v_step.unit));
      EXECUTE format('WITH u AS MATERIALIZED (%1$s),
                           ins AS (INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
                                   SELECT u.ws, u.tn, u.rk, u.fld, NULL, u.nv, ''genesis'', 0, 0, 0, NULL, NULL FROM u
                                    WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL
                                      AND NOT EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = u.ws AND m.table_name = ''baseline''
                                                         AND m.row_key = %2$L AND m.field = %3$L) RETURNING 1)
                      SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM u WHERE u.ws IS NULL OR u.rk IS NULL)', v_step.src_sql, v_step.table_name, v_step.unit)
        INTO v_added, v_skipped;
      v_lines := v_lines + v_added;
    END IF;
    IF v_skipped > 0 THEN
      v_skips := v_skips + v_skipped;
      RAISE NOTICE 'sync_genesis_pass: % row(s) of % (%) have no workspace or a NULL key and were skipped', v_skipped, v_step.table_name, v_step.unit;
    END IF;
  END LOOP;

  -- The markers that say a workspace's baseline of a unit kind is taken (and, on the next call, that it is not taken again).
  INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
  SELECT w.id, 'baseline', s.t, s.u, NULL, NULL, 'genesis', 0, 0, 0, NULL, NULL
    FROM workspaces w
   CROSS JOIN (SELECT DISTINCT e->>0 AS t, e->>1 AS u FROM jsonb_array_elements(v_marks) e) s
   WHERE NOT EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = w.id AND m.table_name = 'baseline' AND m.row_key = s.t AND m.field = s.u);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_stamps, v_lines, v_n, v_skips;
END
$fn$ LANGUAGE plpgsql;
-- 203: a big drawing stored as chunks (db/migrations/203_ink_chunks.sql)
CREATE TABLE IF NOT EXISTS ink_chunks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  hash text NOT NULL,
  content text NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, hash)
);
CREATE INDEX IF NOT EXISTS ink_chunks_workspace_idx ON ink_chunks (workspace_id);

CREATE TABLE IF NOT EXISTS ink_manifests (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  hash text NOT NULL,
  chunks bytea NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, hash)
);
CREATE INDEX IF NOT EXISTS ink_manifests_workspace_idx ON ink_manifests (workspace_id);
-- 204: the joining state and the switch the stamp triggers stand aside on (db/migrations/204_stamped_snapshot_join.sql)
CREATE TABLE IF NOT EXISTS sync_join (
  workspace_id uuid PRIMARY KEY,
  source_node text NOT NULL,
  cut_seq bigint NOT NULL,
  state text NOT NULL DEFAULT 'joining' CHECK (state IN ('joining', 'done')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  person_actor_id uuid,
  shell_person jsonb,
  page_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_through integer NOT NULL DEFAULT 0,
  rows_applied bigint NOT NULL DEFAULT 0,
  import_batches bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_join_one_joining ON sync_join ((true)) WHERE state = 'joining';

CREATE OR REPLACE FUNCTION sync_import_active(p_ws uuid) RETURNS boolean AS $$
BEGIN
  IF COALESCE(current_setting('onden.stamp_import_' || replace(p_ws::text, '-', '_'), true), '') <> 'on' THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION sync_stamp_put(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb) RETURNS void AS $$
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
  VALUES (p_ws, p_table, p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION structure_log_import_skip() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER structure_log_import_skip BEFORE INSERT ON structure_log FOR EACH ROW EXECUTE FUNCTION structure_log_import_skip();

-- order_stamp_set (migration 200) copies the writing transaction's stamp into order_stamp whenever a row is inserted or its key
-- changes. A snapshot row carries the order_stamp its source gave it (it is the tie rule between equal keys, so it has to be
-- the same on every node): while sync_import_active(ws) the function leaves what the importer wrote. The rest is 200's body,
-- word for word (src/test/guards/orderStampSet.guard.test.ts).
CREATE OR REPLACE FUNCTION order_stamp_set() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR NEW.order_key IS DISTINCT FROM OLD.order_key THEN
    s := sync_stamp_current(NEW.workspace_id);
    NEW.order_stamp := lpad(s->>'wall', 15, '0') || lpad(s->>'counter', 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- 205: saw and meta on a stamp, the other heads of a unit, the parent index (db/migrations/205_stamp_saw_heads.sql)
ALTER TABLE sync_stamps ADD COLUMN IF NOT EXISTS saw jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sync_stamps ADD COLUMN IF NOT EXISTS meta jsonb;

CREATE TABLE IF NOT EXISTS sync_stamp_heads (
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_key text NOT NULL,
  field text NOT NULL,
  origin text NOT NULL,
  seq bigint NOT NULL,
  -- a genesis head is named by its content (every node's genesis stamp is the same), so two different genesis values of one unit are two heads:
  content_hash text NOT NULL DEFAULT '',
  hlc_wall bigint NOT NULL,
  hlc_counter integer NOT NULL,
  author text,
  device uuid,
  deleted boolean NOT NULL DEFAULT false,
  saw jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta jsonb,
  value text,
  PRIMARY KEY (workspace_id, table_name, row_key, field, origin, seq, content_hash)
);

ALTER TABLE sync_clock ADD COLUMN IF NOT EXISTS merge_batches bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS content_nodes_parent_idx ON content_nodes (parent_id) WHERE parent_id IS NOT NULL;

-- 204's switch with a second value: 'on' = a snapshot is being imported (the workspace is joining), 'merge' = changes from another node are being written back
-- into a workspace that has joined (spine/stampedMerge/dbUnits.ts). One function decides both, so there is one place that says when the triggers stand aside.
CREATE OR REPLACE FUNCTION sync_import_active(p_ws uuid) RETURNS boolean AS $$
DECLARE mode text := COALESCE(current_setting('onden.stamp_import_' || replace(p_ws::text, '-', '_'), true), '');
BEGIN
  IF mode = 'on' THEN RETURN EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining'); END IF;
  IF mode = 'merge' THEN
    RETURN EXISTS (SELECT 1 FROM sync_clock c WHERE c.workspace_id = p_ws)
       AND NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining');
  END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- What a genesis value is called in a saw: the text of its content, hashed (the same text src/spine/stampedMerge/unit.ts genesisContent makes).
CREATE OR REPLACE FUNCTION sync_content_text(p_value text) RETURNS text AS $$
  SELECT CASE WHEN p_value IS NULL THEN 'j:null' ELSE 's:' || p_value END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION sync_genesis_hash(p_content text) RETURNS text AS $$
  SELECT encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Largest number per origin of two saws.
CREATE OR REPLACE FUNCTION sync_saw_merge(a jsonb, b jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
    SELECT k, max(v) AS v FROM (
      SELECT key AS k, value::text::bigint AS v FROM jsonb_each(a)
      UNION ALL SELECT key, value::text::bigint FROM jsonb_each(b)) x GROUP BY k) y;
$$ LANGUAGE sql IMMUTABLE;

-- Does the unit stand on a genesis value now (its own stamp, or the creation stamp it follows, is genesis)?
CREATE OR REPLACE FUNCTION sync_unit_at_genesis(p_ws uuid, p_table text, p_key text, p_field text) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT s.origin = 'genesis' FROM sync_stamps s WHERE s.workspace_id = p_ws AND s.table_name = p_table AND s.row_key = p_key AND s.field = p_field),
    CASE WHEN p_field <> '*' THEN (SELECT s.origin = 'genesis' FROM sync_stamps s WHERE s.workspace_id = p_ws AND s.table_name = p_table AND s.row_key = p_key AND s.field = '*') END,
    false);
$$ LANGUAGE sql STABLE;

-- What a node has seen of a row when it deletes it for good: the writes behind every unit of the row, so a late edit by someone who had not seen them can be told
-- from one that had (rules/trash.ts `Deletion.seen`). {"seen": origin -> highest sequence number over all the row's units, "heads": field -> [[origin, seq], ...]}.
-- `seen` is only for deciding who is told (never for what is kept; the tombstone's own `saw` speaks about the creation unit only, so it cannot cover a field's write it
-- never saw); `heads` keeps each field's own heads, so the merged number can be worked out again. Genesis stamps are not writes of anyone and are left out. Must run BEFORE
-- the row's field stamps are removed.
CREATE OR REPLACE FUNCTION sync_row_seen(p_ws uuid, p_table text, p_key text) RETURNS jsonb AS $$
  WITH u AS (
    SELECT field, origin, seq FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND origin <> 'genesis'
    UNION SELECT field, origin, seq FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND origin <> 'genesis')
  SELECT jsonb_build_object(
    'seen', COALESCE((SELECT jsonb_object_agg(origin, m) FROM (SELECT origin, max(seq) AS m FROM u GROUP BY origin) x), '{}'::jsonb),
    'heads', COALESCE((SELECT jsonb_object_agg(field, hs) FROM (SELECT field, jsonb_agg(jsonb_build_array(origin, seq) ORDER BY origin, seq) AS hs FROM u GROUP BY field) y), '{}'::jsonb));
$$ LANGUAGE sql STABLE;

-- Write the stamp of a unit (what sync_stamp_put did) together with its saw and meta. p_old = the unit's value before this write, as text, p_old_known = it is given.
CREATE OR REPLACE FUNCTION sync_stamp_put_over(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old text, p_old_known boolean, p_meta jsonb DEFAULT NULL) RETURNS void AS $$
DECLARE
  v_origin text := s->>'origin';
  v_seq bigint := (s->>'seq')::bigint;
  d record;
  h record;
  v_saw jsonb := '{}'::jsonb;
  v_meta jsonb;
  v_again boolean := false;
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    IF d.origin = v_origin AND d.seq = v_seq THEN
      v_again := true; v_saw := d.saw; v_meta := d.meta; -- this transaction wrote the unit already: it has not seen itself
    ELSIF d.origin = 'genesis' THEN
      IF p_field = '*' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash('j:{}'), 0);
      ELSIF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
    ELSE
      v_saw := sync_saw_merge(d.saw, jsonb_build_object(d.origin, d.seq));
    END IF;
  ELSIF p_field <> '*' THEN
    -- no stamp of its own: the field was written together with its row and follows its creation
    SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*';
    IF FOUND AND NOT (d.origin = v_origin AND d.seq = v_seq) THEN
      IF d.origin = 'genesis' THEN
        IF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
      ELSE
        -- what the creation gives a field has no saw of its own (the creation's saw speaks about the creation unit, README "跟著 `*` 的欄位"), only its stamp:
        -- the same state sawOf of the core is given (src/test/stampSaw.integration.test.ts compares the two)
        v_saw := jsonb_build_object(d.origin, d.seq);
      END IF;
    END IF;
    -- the row's creation can have other heads (two nodes made the same derived id): the field follows each of them, so a person's write has seen all of them.
    -- They are the creation's heads, not this field's: they stay.
    FOR h IN SELECT * FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*' AND origin <> 'genesis' LOOP
      IF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object(h.origin, h.seq)); END IF;
    END LOOP;
  END IF;
  -- a write by this node has seen every head the unit had: they are replaced
  FOR h IN DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field RETURNING * LOOP
    IF h.origin = 'genesis' THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object('genesis:' || h.content_hash, 0));
    ELSIF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, sync_saw_merge(h.saw, jsonb_build_object(h.origin, h.seq)));
    END IF;
  END LOOP;
  IF p_meta IS NOT NULL THEN v_meta := p_meta;
  ELSIF NOT v_again AND p_table = 'content_nodes' AND p_field = 'parent' AND p_old_known THEN v_meta := jsonb_build_object('from', p_old); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, p_table, p_key, p_field, v_origin, v_seq, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
END;
$$ LANGUAGE plpgsql;

-- The same for a field that is a column of the row being changed: the old value is read from OLD only when it is needed (the unit stands on a genesis
-- value, or it is a note's parent, whose old value goes to meta), so an edit of a note's body does not copy the old body every time.
CREATE OR REPLACE FUNCTION sync_stamp_put_row(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old_row anyelement, p_column text) RETURNS void AS $$
DECLARE
  v_old text;
  v_known boolean := false;
BEGIN
  IF (p_table = 'content_nodes' AND p_field = 'parent') OR sync_unit_at_genesis(p_ws, p_table, p_key, p_field) THEN
    v_old := sync_logged_value(p_old_row, p_field, p_column); v_known := true;
  END IF;
  PERFORM sync_stamp_put_over(p_ws, p_table, p_key, p_field, p_deleted, s, v_old, v_known);
END;
$$ LANGUAGE plpgsql;

-- The old entry stays, for a caller that does not have the old value: it records saw, without naming a genesis value it cannot see.
CREATE OR REPLACE FUNCTION sync_stamp_put(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb) RETURNS void AS $$
BEGIN
  PERFORM sync_stamp_put_over(p_ws, p_table, p_key, p_field, p_deleted, s, NULL, false);
END;
$$ LANGUAGE plpgsql;

-- the stamp trigger of migration 194 (rows with tracked fields), calling sync_stamp_put_over / sync_stamp_put_row and clearing the other heads of a purged row
CREATE OR REPLACE FUNCTION sync_stamp_trigger() RETURNS trigger AS $$
DECLARE
  tbl text := TG_ARGV[0];
  op text := TG_OP;
  mode text := COALESCE(TG_ARGV[6], '');
  ws uuid;
  key text;
  skey text;
  s jsonb;
  spec text;
  fld text;
  col text;
  kind text;
  ov text;
  nv text;
  cut int;
  filt text := COALESCE(TG_ARGV[7], '');
  keep boolean := true;
  v_seen jsonb;
BEGIN
  IF mode = 'asdelete' THEN op := 'DELETE'; ELSIF mode = 'asinsert' THEN op := 'INSERT'; END IF;
  IF op = 'DELETE' THEN
    ws := sync_workspace(OLD, TG_ARGV[2]); key := sync_key(OLD, TG_ARGV[1]);
    skey := sync_key(OLD, COALESCE(NULLIF(TG_ARGV[5], ''), TG_ARGV[1]));
  ELSE
    ws := sync_workspace(NEW, TG_ARGV[2]); key := sync_key(NEW, TG_ARGV[1]);
    skey := sync_key(NEW, COALESCE(NULLIF(TG_ARGV[5], ''), TG_ARGV[1]));
  END IF;
  IF ws IS NULL THEN RETURN NULL; END IF; -- the notes this row belongs to are already gone: their own tombstone says so
  s := sync_stamp_current(ws);
  IF filt <> '' THEN
    IF op = 'DELETE' THEN keep := sync_column(OLD, split_part(filt, '=', 1)) IS NOT DISTINCT FROM split_part(filt, '=', 2);
    ELSE keep := sync_column(NEW, split_part(filt, '=', 1)) IS NOT DISTINCT FROM split_part(filt, '=', 2); END IF;
  END IF;

  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put_over(ws, tbl, key, '*', false, s, NULL, false);
  ELSIF op = 'DELETE' THEN
    v_seen := sync_row_seen(ws, tbl, key); -- before the fields' stamps go
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = tbl AND row_key = key AND field <> '*';
    DELETE FROM sync_stamp_heads WHERE workspace_id = ws AND table_name = tbl AND row_key = key AND field <> '*';
    PERFORM sync_stamp_put_over(ws, tbl, key, '*', true, s, NULL, false, v_seen);
  ELSE
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[3], ',') LOOP
      fld := split_part(spec, '=', 1);
      col := split_part(spec, '=', 2);
      IF sync_column_changed(OLD, NEW, fld, col) THEN
        PERFORM sync_stamp_put_row(ws, tbl, key, fld, false, s, OLD, col);
      END IF;
    END LOOP;
  END IF;

  IF TG_ARGV[4] <> '' AND keep THEN
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[4], ',') LOOP
      cut := least(NULLIF(position('=' IN spec), 0), NULLIF(position('~' IN spec), 0), NULLIF(position('@' IN spec), 0), NULLIF(position('^' IN spec), 0));
      fld := left(spec, cut - 1); kind := substr(spec, cut, 1); col := substr(spec, cut + 1);
      IF kind = '=' THEN
        -- A created row logs every field; a purged row logs only that it is gone (new value NULL).
        IF op = 'DELETE' THEN
          IF fld <> 'deleted' THEN CONTINUE; END IF;
          ov := sync_logged_value(OLD, fld, col); nv := NULL;
        ELSIF op = 'INSERT' THEN
          ov := NULL; nv := sync_logged_value(NEW, fld, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_logged_value(OLD, fld, col); nv := sync_logged_value(NEW, fld, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSIF kind = '~' THEN
        IF op = 'UPDATE' THEN CONTINUE; END IF;
        IF op = 'DELETE' THEN ov := sync_column(OLD, col); nv := NULL; ELSE ov := NULL; nv := sync_column(NEW, col); END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSIF kind = '^' THEN
        IF op = 'DELETE' THEN ov := sync_column(OLD, col); nv := NULL;
        ELSIF op = 'INSERT' THEN ov := NULL; nv := sync_column(NEW, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_column(OLD, col); nv := sync_column(NEW, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSE -- '@'
        IF op = 'DELETE' THEN ov := sync_composite(OLD, col); nv := NULL;
        ELSIF op = 'INSERT' THEN ov := NULL; nv := sync_composite(NEW, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_composite(OLD, col); nv := sync_composite(NEW, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, op = 'UPDATE');
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- the attribute trigger of migration 199
CREATE OR REPLACE FUNCTION sync_stamp_attribute_trigger() RETURNS trigger AS $$
DECLARE
  old_kept boolean := false;
  new_kept boolean := false;
  op text;
  ws uuid;
  rkey text;
  attr text;
  s jsonb;
  value_changed boolean := false;
  v_seen jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_kept := OLD.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF TG_OP <> 'DELETE' THEN new_kept := NEW.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF NOT old_kept AND NOT new_kept THEN RETURN NULL; END IF;
  -- what this change is to the stamps: a source flip counts as made / removed
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND old_kept AND NOT new_kept) THEN op := 'DELETE';
  ELSIF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NOT old_kept AND new_kept) THEN op := 'INSERT';
  ELSE op := 'UPDATE'; END IF;
  IF op = 'DELETE' THEN
    ws := OLD.workspace_id; rkey := OLD.node_id::text || '/' || OLD.key; attr := OLD.key;
  ELSE
    ws := NEW.workspace_id; rkey := NEW.node_id::text || '/' || NEW.key; attr := NEW.key;
  END IF;
  IF op = 'UPDATE' THEN
    value_changed := OLD.value IS DISTINCT FROM NEW.value;
    IF NOT (value_changed OR OLD.value_type IS DISTINCT FROM NEW.value_type OR OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable) THEN
      RETURN NULL;
    END IF;
  END IF;
  s := sync_stamp_current(ws);
  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put_over(ws, 'node_attributes', rkey, '*', false, s, NULL, false);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', NULL, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', NULL, sync_text_jsonb(NEW.value));
    END IF;
  ELSIF op = 'DELETE' THEN
    v_seen := sync_row_seen(ws, 'node_attributes', rkey); -- before the fields' stamps go
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    DELETE FROM sync_stamp_heads WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put_over(ws, 'node_attributes', rkey, '*', true, s, NULL, false, v_seen);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', OLD.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), NULL);
    END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'value', false, s, OLD, 'value'); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'type', false, s, OLD, 'value_type'); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'inheritable', false, s, OLD, 'is_inheritable'); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), sync_text_jsonb(NEW.value));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- the JSON-unit diff of migration 199: the old value of a unit goes to sync_stamp_put_over
CREATE OR REPLACE FUNCTION sync_stamp_json_diff(p_ws uuid, p_label text, p_row text, p_shape text, p_prefix text,
                                                p_log_table text, p_log_prefix text, p_old jsonb, p_new jsonb) RETURNS void AS $$
DECLARE
  u record;
  s jsonb;
BEGIN
  FOR u IN
    SELECT coalesce(o.k, n.k) AS k, o.v AS old_v, n.v AS new_v
      FROM sync_json_units(p_old, p_shape) o FULL JOIN sync_json_units(p_new, p_shape) n ON o.k = n.k
     WHERE o.v IS DISTINCT FROM n.v
  LOOP
    IF s IS NULL THEN s := sync_stamp_current(p_ws); END IF;
    PERFORM sync_stamp_put_over(p_ws, p_label, p_row, p_prefix || u.k, u.new_v IS NULL, s, u.old_v::text, u.old_v IS NOT NULL);
    IF p_log_table <> '' THEN
      PERFORM sync_structure_put(p_ws, p_log_table, p_row, p_log_prefix || u.k, u.old_v::text, u.new_v::text, s, false);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 206: what a node has taken from which other node, system writes and conflicts, a recreated row keeps what its delete had seen (db/migrations/206_sync_change_bundles.sql)
CREATE TABLE IF NOT EXISTS sync_origins (
  workspace_id uuid NOT NULL,
  origin text NOT NULL,
  vouched_by text NOT NULL,
  have jsonb NOT NULL DEFAULT '{}'::jsonb,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, origin)
);

INSERT INTO sync_origins (workspace_id, origin, vouched_by, have)
SELECT j.workspace_id, j.source_node, 'snapshot', jsonb_build_object('content_nodes', j.cut_seq)
  FROM sync_join j WHERE j.state = 'done'
ON CONFLICT (workspace_id, origin) DO NOTHING;

CREATE OR REPLACE FUNCTION structure_log_import_skip() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) AND COALESCE(current_setting('onden.merge_structure_line', true), '') <> 'on' THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A note's `updated_at` is a function of the stamps that replicate: the largest wall time (ms) among the stamps of the row's units that COUNT as an edit (the other heads too). Three kinds
-- of stamp do not count, as today's write path (services/nodeUpdate.ts applyNodeColumns): the creation `*` (a row's `updated_at` at its creation is the value the INSERT gave it, which an import or a bundle carries as a column), the unit `sort` (a position among siblings is not an edit), and a stamp whose writer said "this save is housekeeping"
-- (`meta.quiet = true`: the write path sets onden.stamp_quiet around the UPDATE of a save that keeps `updated_at`: block-id migration, marker repair, link rewrite). Only the writer knows the third, so it is
-- written into the stamp's meta, where every node reads it. Every node computes the result from the
-- same stamps, so it is the same on every node; a local write sets it here (sync_stamp_put_over below) and a merge sets it after it wrote the stamps (src/spine/stampedMerge/dbRows.ts). A row with only
-- genesis stamps (wall 0) keeps what it has. Writes that do not pass through the row's units (attributes, tags, ...) still set it by their own code today: pinned in stampedBundle.integration.test.ts.
CREATE OR REPLACE FUNCTION sync_touch_updated_at(p_ws uuid, p_key text) RETURNS void AS $$
DECLARE v_wall bigint;
BEGIN
  SELECT max(w) INTO v_wall FROM (
    SELECT hlc_wall AS w FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true'
    UNION ALL SELECT hlc_wall FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true') x;
  IF v_wall IS NOT NULL AND v_wall > 0 THEN
    UPDATE content_nodes SET updated_at = to_timestamp(v_wall / 1000.0) WHERE id = p_key::uuid AND workspace_id = p_ws AND updated_at IS DISTINCT FROM to_timestamp(v_wall / 1000.0);
  END IF;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sync_stamp_put_over(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old text, p_old_known boolean, p_meta jsonb DEFAULT NULL) RETURNS void AS $$
DECLARE
  v_origin text := s->>'origin';
  v_seq bigint := (s->>'seq')::bigint;
  d record;
  h record;
  v_saw jsonb := '{}'::jsonb;
  v_meta jsonb;
  v_again boolean := false;
  v_prev_seen jsonb;
  v_quiet boolean := p_field <> '*' AND COALESCE(current_setting('onden.stamp_quiet', true), '') = 'on'; -- this write is housekeeping: it does not count for `updated_at`
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    v_prev_seen := d.meta -> 'seen'; -- what a delete of this row had seen, carried by a creation that covers it
    IF d.origin = v_origin AND d.seq = v_seq THEN
      v_again := true; v_saw := d.saw; v_meta := d.meta; -- this transaction wrote the unit already: it has not seen itself
    ELSIF d.origin = 'genesis' THEN
      IF p_field = '*' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash('j:{}'), 0);
      ELSIF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
    ELSE
      v_saw := sync_saw_merge(d.saw, jsonb_build_object(d.origin, d.seq));
    END IF;
  ELSIF p_field <> '*' THEN
    -- no stamp of its own: the field was written together with its row and follows its creation
    SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*';
    IF FOUND AND NOT (d.origin = v_origin AND d.seq = v_seq) THEN
      IF d.origin = 'genesis' THEN
        IF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
      ELSE
        -- what the creation gives a field has no saw of its own (the creation's saw speaks about the creation unit, README "跟著 `*` 的欄位"), only its stamp:
        -- the same state sawOf of the core is given (src/test/stampSaw.integration.test.ts compares the two)
        v_saw := jsonb_build_object(d.origin, d.seq);
      END IF;
    END IF;
    -- the row's creation can have other heads (two nodes made the same derived id): the field follows each of them, so a person's write has seen all of them.
    -- They are the creation's heads, not this field's: they stay.
    FOR h IN SELECT * FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*' AND origin <> 'genesis' LOOP
      IF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object(h.origin, h.seq)); END IF;
    END LOOP;
  END IF;
  -- a system job does not resolve a conflict nobody has looked at: its write has seen only the head the unit shows, and a `saw` cannot say that
  IF COALESCE(s->>'system', '') = 'true' AND NOT v_again
     AND EXISTS (SELECT 1 FROM sync_stamp_heads x WHERE x.workspace_id = p_ws AND x.table_name = p_table AND x.row_key = p_key AND x.field = p_field) THEN
    RAISE EXCEPTION 'sync_unit_in_conflict' USING ERRCODE = 'ON001';
  END IF;
  -- a write by this node has seen every head the unit had: they are replaced
  FOR h IN DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field RETURNING * LOOP
    IF h.origin = 'genesis' THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object('genesis:' || h.content_hash, 0));
    ELSIF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, sync_saw_merge(h.saw, jsonb_build_object(h.origin, h.seq)));
    END IF;
  END LOOP;
  IF p_meta IS NOT NULL THEN v_meta := p_meta;
  ELSIF NOT v_again AND p_table = 'content_nodes' AND p_field = 'parent' AND p_old_known THEN v_meta := jsonb_build_object('from', p_old);
  ELSIF NOT v_again AND p_field = '*' AND NOT p_deleted AND v_prev_seen IS NOT NULL THEN v_meta := jsonb_build_object('seen', v_prev_seen); END IF;
  IF v_quiet THEN v_meta := COALESCE(v_meta, '{}'::jsonb) || '{"quiet": true}'::jsonb;
  ELSIF v_meta ? 'quiet' THEN v_meta := NULLIF(v_meta - 'quiet', '{}'::jsonb); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, p_table, p_key, p_field, v_origin, v_seq, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
  IF p_table = 'content_nodes' AND NOT p_deleted AND NOT v_quiet AND p_field NOT IN ('*', 'sort') THEN PERFORM sync_touch_updated_at(p_ws, p_key); END IF;
END;
$$ LANGUAGE plpgsql;
-- 207: single-use tickets for "just proved who they are" (db/migrations/207_fresh_proofs.sql)
CREATE TABLE IF NOT EXISTS fresh_proofs (
  ticket_hash text PRIMARY KEY,
  actor_id    uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  purpose     text NOT NULL,
  session_id  text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS fresh_proofs_expires_idx ON fresh_proofs (expires_at);
CREATE TABLE IF NOT EXISTS fresh_proof_attempts (
  actor_id     uuid PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  failures     integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);

-- 209: a note's place is one write: a move stamps its order key too; a key of a tag's schema counts for updated_at; the module sets are stored sorted (db/migrations/209_place_is_one_write.sql)
CREATE OR REPLACE FUNCTION sync_stamp_place_with_parent() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_stamp_put_row(NEW.workspace_id, 'content_nodes', NEW.id::text, 'sort', false, sync_stamp_current(NEW.workspace_id), OLD, 'order_key');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_place AFTER UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id AND OLD.order_key IS NOT DISTINCT FROM NEW.order_key)
  EXECUTE FUNCTION sync_stamp_place_with_parent();

CREATE OR REPLACE FUNCTION order_stamp_follow_parent() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  s := sync_stamp_current(NEW.workspace_id);
  NEW.order_stamp := lpad(s->>'wall', 15, '0') || lpad(s->>'counter', 6, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_order_stamp_parent BEFORE UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id AND OLD.order_key IS NOT DISTINCT FROM NEW.order_key)
  EXECUTE FUNCTION order_stamp_follow_parent();

-- A note's `updated_at` is a function of the stamps that replicate (206): the largest wall time (ms) among the stamps of the row's units that COUNT as an edit, now also the keys of its tag schema.
CREATE OR REPLACE FUNCTION sync_touch_updated_at(p_ws uuid, p_key text) RETURNS void AS $$
DECLARE v_wall bigint;
BEGIN
  SELECT max(w) INTO v_wall FROM (
    SELECT hlc_wall AS w FROM sync_stamps WHERE workspace_id = p_ws AND table_name IN ('content_nodes', 'content_nodes.tag_schema') AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true'
    UNION ALL SELECT hlc_wall FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name IN ('content_nodes', 'content_nodes.tag_schema') AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true') x;
  IF v_wall IS NOT NULL AND v_wall > 0 THEN
    UPDATE content_nodes SET updated_at = to_timestamp(v_wall / 1000.0) WHERE id = p_key::uuid AND workspace_id = p_ws AND updated_at IS DISTINCT FROM to_timestamp(v_wall / 1000.0);
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_touch_after_json() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_touch_updated_at(NEW.workspace_id, NEW.id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- named to run after content_nodes_tag_schema_stamp_update (AFTER triggers run in name order): the keys are stamped first
CREATE OR REPLACE TRIGGER content_nodes_tag_schema_touch AFTER UPDATE OF tag_schema ON content_nodes FOR EACH ROW
  WHEN (OLD.tag_schema IS DISTINCT FROM NEW.tag_schema)
  EXECUTE FUNCTION sync_touch_after_json();

-- A set of module ids (an array of strings) as it is stored: sorted by byte, each id once. Anything that is not an array is left as it is.
CREATE OR REPLACE FUNCTION sync_set_sorted(p jsonb) RETURNS jsonb AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'array'
    THEN COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e COLLATE "C") FROM (SELECT DISTINCT e FROM jsonb_array_elements_text(p) e) x), '[]'::jsonb)
    ELSE p END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION workspaces_sets_sorted() RETURNS trigger AS $$
BEGIN
  NEW.modules_off := sync_set_sorted(NEW.modules_off);
  NEW.modules_confirmed := sync_set_sorted(NEW.modules_confirmed);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER workspaces_sets_sorted BEFORE INSERT OR UPDATE OF modules_off, modules_confirmed ON workspaces FOR EACH ROW
  EXECUTE FUNCTION workspaces_sets_sorted();

-- A board's section frames are one unit, the attribute's `value` (it travels in a change bundle like any attribute). From now on the attribute trigger stamps only that
-- unit; until now it also stamped each section (label node_attributes._canvas_sections, migration 199), a second kind of unit over the same data that nothing reads and
-- nothing copies (src/spine/snapshotTables.ts RETIRED_STAMP_LABELS). The text below is 205's, without the three per-section calls; the structure log lines stay.
CREATE OR REPLACE FUNCTION sync_stamp_attribute_trigger() RETURNS trigger AS $$
DECLARE
  old_kept boolean := false;
  new_kept boolean := false;
  op text;
  ws uuid;
  rkey text;
  attr text;
  s jsonb;
  value_changed boolean := false;
  v_seen jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_kept := OLD.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF TG_OP <> 'DELETE' THEN new_kept := NEW.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF NOT old_kept AND NOT new_kept THEN RETURN NULL; END IF;
  -- what this change is to the stamps: a source flip counts as made / removed
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND old_kept AND NOT new_kept) THEN op := 'DELETE';
  ELSIF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NOT old_kept AND new_kept) THEN op := 'INSERT';
  ELSE op := 'UPDATE'; END IF;
  IF op = 'DELETE' THEN
    ws := OLD.workspace_id; rkey := OLD.node_id::text || '/' || OLD.key; attr := OLD.key;
  ELSE
    ws := NEW.workspace_id; rkey := NEW.node_id::text || '/' || NEW.key; attr := NEW.key;
  END IF;
  IF op = 'UPDATE' THEN
    value_changed := OLD.value IS DISTINCT FROM NEW.value;
    IF NOT (value_changed OR OLD.value_type IS DISTINCT FROM NEW.value_type OR OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable) THEN
      RETURN NULL;
    END IF;
  END IF;
  s := sync_stamp_current(ws);
  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put_over(ws, 'node_attributes', rkey, '*', false, s, NULL, false);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', NULL, NEW.value, s, false);
    END IF;
  ELSIF op = 'DELETE' THEN
    v_seen := sync_row_seen(ws, 'node_attributes', rkey); -- before the fields' stamps go
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    DELETE FROM sync_stamp_heads WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put_over(ws, 'node_attributes', rkey, '*', true, s, NULL, false, v_seen);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false);
    END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'value', false, s, OLD, 'value'); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'type', false, s, OLD, 'value_type'); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'inheritable', false, s, OLD, 'is_inheritable'); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The genesis pass (202) is 202's text without the per-section step: a database that runs it from now on (a browser node at its first start, src/browser/nodeIdentity.ts)
-- gives no section its own stamp either.
CREATE OR REPLACE FUNCTION sync_genesis_pass() RETURNS TABLE (stamps_added bigint, baseline_lines_added bigint, markers_added bigint, rows_skipped bigint) AS $fn$
DECLARE
  v_step record;
  v_added bigint;
  v_skipped bigint;
  v_stamps bigint := 0;
  v_lines bigint := 0;
  v_skips bigint := 0;
  v_marks jsonb := '[]'::jsonb;
  v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE NOT t.tgisinternal AND p.proname LIKE 'sync\_%trigger'
                AND p.proname NOT IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')) THEN
    RAISE EXCEPTION '202 (sync_genesis_pass): a stamp trigger function this migration does not know is installed; extend the plan before running it';
  END IF;

  FOR v_step IN
    WITH trg AS (
      SELECT c.relname::text AS tbl, p.proname::text AS fn,
             string_to_array(encode(t.tgargs, 'escape'), '\000') AS a,
             (regexp_match(pg_get_triggerdef(t.oid), ' WHEN \((.*)\) EXECUTE FUNCTION '))[1] AS wh
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND pg_table_is_visible(c.oid)
         AND (t.tgtype & 5) = 5 AND (t.tgtype & 2) = 0
         AND p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')
    ),
    g AS (
      SELECT trg.*,
             CASE WHEN a[3] LIKE 'via:%'
                    THEN 'COALESCE(' || (SELECT string_agg(format('(SELECT n.workspace_id FROM content_nodes n WHERE n.id = t.%I)', c), ', ' ORDER BY o)
                                           FROM unnest(string_to_array(substr(a[3], 5), ',')) WITH ORDINALITY AS u(c, o)) || ')'
                  WHEN a[3] LIKE 'space:%' THEN format('(SELECT s.workspace_id FROM spaces s WHERE s.id = t.%I)', substr(a[3], 7))
                  ELSE format('t.%I', a[3]) END AS ws_sql,
             (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
                FROM unnest(string_to_array(a[2], ',')) WITH ORDINALITY AS u(c, o)) AS key_sql,
             (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
                FROM unnest(string_to_array(COALESCE(NULLIF(a[6], ''), a[2]), ',')) WITH ORDINALITY AS u(c, o)) AS log_key_sql,
             COALESCE(regexp_replace(wh, '\mnew\.', 't.', 'gi'), 'true') AS when_sql,
             CASE WHEN COALESCE(a[8], '') = '' THEN 'true'
                  ELSE format('t.%I::text IS NOT DISTINCT FROM %L', split_part(a[8], '=', 1), split_part(a[8], '=', 2)) END AS filter_sql
        FROM trg WHERE fn <> 'sync_stamp_attribute_trigger'
    ),
    fields AS (
      SELECT g.*, left(x.spec, x.cut - 1) AS fld, substr(x.spec, x.cut, 1) AS kind, substr(x.spec, x.cut + 1) AS col
        FROM g
       CROSS JOIN LATERAL (SELECT s.spec, least(NULLIF(position('=' IN s.spec), 0), NULLIF(position('~' IN s.spec), 0),
                                                NULLIF(position('@' IN s.spec), 0), NULLIF(position('^' IN s.spec), 0)) AS cut
                             FROM unnest(string_to_array(g.a[5], ',')) AS s(spec)) x
       WHERE g.fn = 'sync_stamp_trigger' AND COALESCE(g.a[5], '') <> ''
    ),
    plan AS (
      SELECT 'stamps' AS part, a[1] AS table_name, 'row' AS unit,
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, NULL::text AS nv FROM %I t WHERE %s',
                    ws_sql, a[1], key_sql, '*', tbl, when_sql) AS src_sql
        FROM g WHERE fn = 'sync_stamp_trigger'
      UNION ALL
      SELECT 'stamps', a[1], a[6] || '*',
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, NULL::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
                    ws_sql, a[1], key_sql, a[6], tbl, a[4], a[5], when_sql)
        FROM g WHERE fn = 'sync_stamp_json_trigger'
      UNION ALL
      SELECT 'stamps', 'node_attributes', 'row (a person or automation wrote it)',
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''*'' AS fld, NULL::text AS nv FROM node_attributes t WHERE t.source IN (''ui'', ''explicit'', ''dispatcher'')'
        FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
      UNION ALL
      SELECT 'structure baseline', a[1], fld,
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, %s AS nv FROM %I t WHERE %s AND %s',
                    ws_sql, a[1], log_key_sql, fld,
                    CASE WHEN kind = '=' AND fld = 'deleted' THEN format('(t.%I IS NOT NULL)::text', col)
                         WHEN kind = '@' OR (kind = '=' AND position('+' IN col) > 0)
                           THEN 'jsonb_build_object(' || (SELECT string_agg(format('%L, t.%I', c, c), ', ' ORDER BY o)
                                                            FROM unnest(string_to_array(col, '+')) WITH ORDINALITY AS u(c, o)) || ')::text'
                         ELSE format('t.%I::text', col) END,
                    tbl, when_sql, filter_sql)
        FROM fields
      UNION ALL
      SELECT 'structure baseline', a[7], a[8] || '*',
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, u.v::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
                    ws_sql, a[7], key_sql, a[8], tbl, a[4], a[5], when_sql)
        FROM g WHERE fn = 'sync_stamp_json_trigger' AND COALESCE(a[7], '') <> ''
      UNION ALL
      SELECT 'structure baseline', 'node_attributes', 'sections',
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''sections'' AS fld, t.value AS nv FROM node_attributes t WHERE t.key = ''_canvas_sections'' AND t.source IN (''ui'', ''explicit'', ''dispatcher'')'
        FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
    )
    SELECT DISTINCT part, table_name, unit, src_sql FROM plan ORDER BY part, table_name, unit
  LOOP
    IF v_step.part = 'stamps' THEN
      EXECUTE format('WITH u AS MATERIALIZED (%s),
                           ins AS (INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
                                   SELECT u.ws, u.tn, u.rk, u.fld, ''genesis'', 0, 0, 0, NULL, NULL, false FROM u
                                    WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL
                                   ON CONFLICT (workspace_id, table_name, row_key, field) DO NOTHING RETURNING 1)
                      SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM u WHERE u.ws IS NULL OR u.rk IS NULL)', v_step.src_sql)
        INTO v_added, v_skipped;
      v_stamps := v_stamps + v_added;
    ELSE
      v_marks := v_marks || jsonb_build_array(jsonb_build_array(v_step.table_name, v_step.unit));
      EXECUTE format('WITH u AS MATERIALIZED (%1$s),
                           ins AS (INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
                                   SELECT u.ws, u.tn, u.rk, u.fld, NULL, u.nv, ''genesis'', 0, 0, 0, NULL, NULL FROM u
                                    WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL
                                      AND NOT EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = u.ws AND m.table_name = ''baseline''
                                                         AND m.row_key = %2$L AND m.field = %3$L) RETURNING 1)
                      SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM u WHERE u.ws IS NULL OR u.rk IS NULL)', v_step.src_sql, v_step.table_name, v_step.unit)
        INTO v_added, v_skipped;
      v_lines := v_lines + v_added;
    END IF;
    IF v_skipped > 0 THEN
      v_skips := v_skips + v_skipped;
      RAISE NOTICE 'sync_genesis_pass: % row(s) of % (%) have no workspace or a NULL key and were skipped', v_skipped, v_step.table_name, v_step.unit;
    END IF;
  END LOOP;

  -- The markers that say a workspace's baseline of a unit kind is taken (and, on the next call, that it is not taken again).
  INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
  SELECT w.id, 'baseline', s.t, s.u, NULL, NULL, 'genesis', 0, 0, 0, NULL, NULL
    FROM workspaces w
   CROSS JOIN (SELECT DISTINCT e->>0 AS t, e->>1 AS u FROM jsonb_array_elements(v_marks) e) s
   WHERE NOT EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = w.id AND m.table_name = 'baseline' AND m.row_key = s.t AND m.field = s.u);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_stamps, v_lines, v_n, v_skips;
END
$fn$ LANGUAGE plpgsql;
-- 210: a session as a temporary participant (db/migrations/210_participant_sessions.sql)
ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_type_check;
ALTER TABLE actors ADD CONSTRAINT actors_type_check CHECK (type IN ('human', 'agent', 'session'));
CREATE TABLE IF NOT EXISTS participant_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id        uuid NOT NULL UNIQUE REFERENCES actors(id) ON DELETE CASCADE,
  opened_by       uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  credential_hash text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  max_requests    integer NOT NULL CHECK (max_requests > 0),
  request_count   bigint NOT NULL DEFAULT 0,
  max_bytes       bigint NOT NULL CHECK (max_bytes > 0),
  byte_count      bigint NOT NULL DEFAULT 0,
  last_used_at    timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS participant_sessions_opener_idx ON participant_sessions (opened_by) WHERE ended_at IS NULL;
-- 213: a restored database takes a new node id (db/migrations/213_renew_node_id.sql)
CREATE OR REPLACE FUNCTION sync_take_node_id() RETURNS TABLE (before_id text, after_id text) AS $$
DECLARE v_before text; v_after text;
BEGIN
  SELECT n.node_id INTO v_before FROM sync_node n WHERE n.singleton FOR UPDATE;
  INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text)
    ON CONFLICT (singleton) DO UPDATE SET node_id = EXCLUDED.node_id
    RETURNING sync_node.node_id INTO v_after;
  RETURN QUERY SELECT v_before, v_after;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_renew_node_id() RETURNS TABLE (old_node_id text, new_node_id text, workspaces bigint, origins_added bigint) AS $$
DECLARE v_ws uuid; v_old text; v_new text; v_clocks bigint; v_origins bigint;
BEGIN
  -- every writer takes a workspace's event-append lock, then its clock row (spine/stamps.ts); a renewal takes all of them, in one order
  FOR v_ws IN SELECT c.workspace_id FROM sync_clock c ORDER BY c.workspace_id LOOP
    PERFORM 1 FROM sync_lock_clock(v_ws);
  END LOOP;
  SELECT t.before_id, t.after_id INTO v_old, v_new FROM sync_take_node_id() t;
  -- the old id's own writes, as an origin held up to the last number it gave (before the clock is renumbered below)
  IF v_old IS NOT NULL THEN
    -- held up to that number for every label a change bundle carries: the same shape as spine/stampedBundle.ts haveOfAll, from the one list
    -- spine/stampedMerge/dbUnits.ts CARRIED_LABELS (restoreRenewsNodeId.guard.test.ts keeps the two equal: a label added there needs a migration here)
    INSERT INTO sync_origins (workspace_id, origin, vouched_by, have)
    SELECT c.workspace_id, v_old, 'self-restore', (SELECT jsonb_object_agg(l, c.next_seq - 1) FROM unnest(ARRAY['workspaces', 'spaces', 'space_members', 'content_nodes', 'node_attributes', 'node_tags', 'node_edges', 'note_pointers', 'node_positions', 'function_refs', 'rss_subscriptions', 'rss_mutes', 'external_calendars', 'actor_module_settings', 'content_nodes.tag_schema', 'spaces.capabilities', 'function_refs.config', 'workspaces.modules_off', 'workspaces.modules_confirmed']) AS l)
      FROM sync_clock c WHERE c.next_seq > 1;
    GET DIAGNOSTICS v_origins = ROW_COUNT;
  ELSE
    v_origins := 0;
  END IF;
  WITH top AS (
    SELECT s.workspace_id, s.hlc_wall, s.hlc_counter FROM sync_stamps s
    UNION ALL SELECT h.workspace_id, h.hlc_wall, h.hlc_counter FROM sync_stamp_heads h
  ), best AS (
    SELECT DISTINCT ON (workspace_id) workspace_id, hlc_wall, hlc_counter FROM top ORDER BY workspace_id, hlc_wall DESC, hlc_counter DESC
  )
  UPDATE sync_clock c SET next_seq = 1,
         hlc_wall = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_wall ELSE c.hlc_wall END,
         hlc_counter = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_counter ELSE c.hlc_counter END
    FROM sync_clock c2 LEFT JOIN best b ON b.workspace_id = c2.workspace_id
   WHERE c2.workspace_id = c.workspace_id;
  GET DIAGNOSTICS v_clocks = ROW_COUNT;
  RETURN QUERY SELECT v_old, v_new, v_clocks, v_origins;
END;
$$ LANGUAGE plpgsql;
-- 214: a snapshot of a restored, renewed server names its former node ids; the join remembers them (db/migrations/214_sync_join_source_former.sql)
ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS source_former jsonb NOT NULL DEFAULT '{}'::jsonb;
-- 212: a write's event position kept with its idempotency key (db/migrations/212_idempotency_event_position.sql)
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS event_position bigint;


-- 215: a body write's anchors and paragraph rows are replicated: stamp triggers on block_anchors and block_nodes, the notes' anchors units, and the anchor hash guard (db/migrations/215_block_anchors_replicated.sql)
-- 1. block_anchors: the row (its id) and `note` ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_insert AFTER INSERT ON block_anchors FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', '');
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_update AFTER UPDATE ON block_anchors FOR EACH ROW
  WHEN (OLD.anchor_id IS NOT DISTINCT FROM NEW.anchor_id AND OLD.note_id IS DISTINCT FROM NEW.note_id)
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', '');
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_rekey_gone AFTER UPDATE ON block_anchors FOR EACH ROW
  WHEN (OLD.anchor_id IS DISTINCT FROM NEW.anchor_id)
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', 'asdelete');
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_rekey_made AFTER UPDATE ON block_anchors FOR EACH ROW
  WHEN (OLD.anchor_id IS DISTINCT FROM NEW.anchor_id)
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', 'asinsert');
-- The three tables of this migration file a row's stamps under its note ('via:note_id', the rule of every table filed under a note, migration 194): anything the
-- foreign key's cascade does to a row on the way out with its note (a task link set to null) writes no stamp of its own (review of PR #1853, round 5, point 1). Whenever
-- the note is there this is the row's own workspace_id, the column every read uses. A row's delete is a statement trigger (section 2c: what goes with its note).

-- 1b. note_anchor_places: ONE unit per note, the places of all its anchors (review of PR #1853, round 2) ---------------------------------------------------
-- `places` = {"h": <sha-256 of the note's body>, "a": {<anchor id>: [from, to, status, candidate_from, candidate_to, recovery_pending, quote, prefix, suffix]}}; an anchor
-- whose own at_body_hash is not "h" (a row left stale before 215 and not looked at since) carries that hash as a tenth element, so the expansion gives back the row exactly.
-- The text is jsonb's own (keys by length then bytes, ", " and ": "): a received unit written any other way is refused (spine/stampedMerge/anchorUnit.ts parseAnchorUnit).
-- On the node that writes, the unit FOLLOWS the rows: after every statement that wrote anchors of a note, note_anchor_places_follow() writes the note's unit from
-- its rows (one row and one stamp per note per statement, whatever the number of anchors). On a node that takes a bundle, the rows follow the unit:
-- the merge core picks the head whose "h" is the stored body's (spine/stampedMerge/anchorUnit.ts chooseAnchorHead) and writes it into the rows (note_anchor_places_expand_all).
CREATE TABLE IF NOT EXISTS note_anchor_places (
  note_id uuid PRIMARY KEY REFERENCES content_nodes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  places jsonb NOT NULL
);
CREATE OR REPLACE TRIGGER note_anchor_places_sync_stamp_insert AFTER INSERT ON note_anchor_places FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_anchor_places', 'note_id', 'via:note_id', 'places=places', '', '', '');
CREATE OR REPLACE TRIGGER note_anchor_places_sync_stamp_update AFTER UPDATE ON note_anchor_places FOR EACH ROW
  WHEN (OLD.places IS DISTINCT FROM NEW.places)
  EXECUTE FUNCTION sync_stamp_trigger('note_anchor_places', 'note_id', 'via:note_id', 'places=places', '', '', '');

-- The one thing this file remembers within a transaction is the hash of the last body it worked out, `onden.anchor_body_last` = "<note id>|<ctid>|<sha-256>"
-- (block_anchor_body_hash): one entry, so its cost does not grow with the notes a transaction touches (review of PR #1853, round 4, point 2).
-- The one way from a row to its entry in a unit measured on the body `p_h` (an anchor whose own at_body_hash is not `p_h` carries it as a tenth element).
CREATE OR REPLACE FUNCTION note_anchor_entry(p_from int, p_to int, p_status text, p_cf int, p_ct int, p_pending boolean, p_quote text, p_prefix text, p_suffix text,
                                             p_hash text, p_h text) RETURNS jsonb AS $$
  SELECT jsonb_build_array(p_from, p_to, p_status, p_cf, p_ct, p_pending, p_quote, p_prefix, p_suffix) || CASE WHEN p_hash = p_h THEN '[]'::jsonb ELSE jsonb_build_array(p_hash) END;
$$ LANGUAGE sql IMMUTABLE;
-- The anchors of `p_note` as its unit names them ("a"), measured on `p_h`. NULL when the note has no anchor row.
CREATE OR REPLACE FUNCTION note_anchor_places_of(p_ws uuid, p_note uuid, p_h text) RETURNS jsonb AS $$
  SELECT jsonb_object_agg(a.anchor_id, note_anchor_entry(a.from_utf16, a.to_utf16, a.status, a.candidate_from_utf16, a.candidate_to_utf16, a.recovery_pending,
           a.quote, a.quote_prefix, a.quote_suffix, a.at_body_hash, p_h))
    FROM block_anchors a WHERE a.workspace_id = p_ws AND a.note_id = p_note;
$$ LANGUAGE sql STABLE;
-- The one way from a unit to a row: the place of an anchor row as `p_entry` (the chosen head's entry for it, or NULL) makes it, measured on `p_hash`.
--   named by the chosen head: its place as the head says;
--   not named (made by a write whose body lost, or no head on the stored body): it stands nowhere and is `lost`, measured on `p_hash`; its words are `p_words`
--   ([quote, prefix, suffix] from the newest head that names it, spine/stampedMerge/anchorUnit.ts chooseAnchorHead), or, when no head names it, none: what the row
--   held is history (the words an earlier expansion wrote, or a sender's row as it stood), not replicated state (review of PR #1853, round 4, point 6). It is then
--   an anchor that is never found again.
CREATE OR REPLACE FUNCTION note_anchor_place(p_entry jsonb, p_words jsonb, p_quote text, p_prefix text, p_suffix text, p_hash text,
    OUT from_utf16 int, OUT to_utf16 int, OUT status text, OUT candidate_from_utf16 int, OUT candidate_to_utf16 int, OUT recovery_pending boolean,
    OUT quote text, OUT quote_prefix text, OUT quote_suffix text, OUT at_body_hash text) AS $$
  SELECT COALESCE((p_entry->>0)::int, 0), COALESCE((p_entry->>1)::int, 0), COALESCE(p_entry->>2, 'lost'),
         CASE WHEN p_entry IS NULL THEN NULL ELSE (p_entry->>3)::int END, CASE WHEN p_entry IS NULL THEN NULL ELSE (p_entry->>4)::int END,
         COALESCE((p_entry->>5)::boolean, false),
         CASE WHEN p_entry IS NULL THEN COALESCE(p_words->>0, '') ELSE COALESCE(p_entry->>6, p_quote) END,
         CASE WHEN p_entry IS NULL THEN COALESCE(p_words->>1, '') ELSE COALESCE(p_entry->>7, p_prefix) END,
         CASE WHEN p_entry IS NULL THEN COALESCE(p_words->>2, '') ELSE COALESCE(p_entry->>8, p_suffix) END, COALESCE(p_entry->>9, p_hash);
$$ LANGUAGE sql IMMUTABLE;

-- The largest unit a node takes, in bytes of its text (UTF-8, the text jsonb writes): spine/stampedMerge/anchorUnit.ts ANCHOR_UNIT_BYTES_MAX is the same number (a test
-- compares the two). A writer never writes a larger one (note_anchor_places_write): a unit every receiver refuses would stop the writer's whole stream, not one note.
CREATE OR REPLACE FUNCTION anchor_unit_bytes_max() RETURNS bigint AS $$ SELECT 16000000::bigint $$ LANGUAGE sql IMMUTABLE;
-- The unit of `p_note` from its anchor rows, written when it differs (no rows: the unit is removed). When it would be larger than anchor_unit_bytes_max(), the words
-- (quote and context) of the note's anchors are dropped, the oldest lost ones first, then the oldest `maybe` ones, then the oldest valid ones, until it is not: a lost
-- anchor without its words is never found again (its paragraph row stays hidden and its task in the trash, its links say the paragraph is gone); a `maybe` one can no
-- longer be confirmed by its words; a valid one keeps its place, and takes new words the next time a save moves it. The rows are written too, so the unit is still
-- its rows (review of PR #1853, round 4, point 3).
CREATE OR REPLACE FUNCTION note_anchor_places_write(p_ws uuid, p_note uuid) RETURNS void AS $$
DECLARE v_h text; v jsonb; v_over bigint; v_lost bigint; v_maybe bigint; v_valid bigint;
BEGIN
  v_h := block_anchor_body_hash(p_note);
  IF v_h IS NULL THEN RETURN; END IF; -- the note is gone: its unit went with it
  -- a row measured on this body that code before 215 left in a shape no writer gives it now (valid with a candidate or waiting to be looked up; not valid and standing
  -- somewhere: services/blockAnchors/mapping.ts) would make a unit every receiver refuses: it is put right here, whatever wrote the note's anchors (a save puts it
  -- right too; a write of one anchor's place would not have). Rows measured on another body carry their own hash in the unit and are taken as they are.
  UPDATE block_anchors SET candidate_from_utf16 = CASE WHEN status = 'valid' THEN NULL ELSE candidate_from_utf16 END,
         candidate_to_utf16 = CASE WHEN status = 'valid' THEN NULL ELSE candidate_to_utf16 END, recovery_pending = CASE WHEN status = 'valid' THEN false ELSE recovery_pending END,
         from_utf16 = CASE WHEN status = 'valid' THEN from_utf16 ELSE 0 END, to_utf16 = CASE WHEN status = 'valid' THEN to_utf16 ELSE 0 END
   WHERE workspace_id = p_ws AND note_id = p_note AND at_body_hash = v_h
     AND CASE WHEN status = 'valid' THEN candidate_from_utf16 IS NOT NULL OR candidate_to_utf16 IS NOT NULL OR recovery_pending ELSE from_utf16 <> 0 OR to_utf16 <> 0 END;
  v := note_anchor_places_of(p_ws, p_note, v_h);
  IF v IS NULL THEN
    DELETE FROM note_anchor_places WHERE note_id = p_note;
    RETURN;
  END IF;
  v_over := octet_length(jsonb_build_object('h', v_h, 'a', v)::text) - anchor_unit_bytes_max();
  IF v_over > 0 THEN
    -- what each anchor's words take in the unit's text (each written as a JSON string; an empty one is two bytes), in the order they are given up
    WITH given AS (
      UPDATE block_anchors a SET quote = '', quote_prefix = '', quote_suffix = ''
        FROM (SELECT d.anchor_id, COALESCE(sum(d.words) OVER (ORDER BY d.rank, d.created_at, d.anchor_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
                FROM (SELECT b.anchor_id, b.created_at, CASE b.status WHEN 'lost' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END AS rank,
                             octet_length(to_jsonb(b.quote)::text) + octet_length(to_jsonb(b.quote_prefix)::text) + octet_length(to_jsonb(b.quote_suffix)::text) - 6 AS words
                        FROM block_anchors b WHERE b.workspace_id = p_ws AND b.note_id = p_note) d) g
       WHERE a.workspace_id = p_ws AND a.note_id = p_note AND a.anchor_id = g.anchor_id AND g.before < v_over
         AND (a.quote, a.quote_prefix, a.quote_suffix) IS DISTINCT FROM ('', '', '')
      RETURNING a.status)
    SELECT count(*) FILTER (WHERE status = 'lost'), count(*) FILTER (WHERE status = 'maybe'), count(*) FILTER (WHERE status NOT IN ('lost', 'maybe'))
      INTO v_lost, v_maybe, v_valid FROM given;
    -- words given up cannot be had back: one line in the database's log names the note and how many of each kind (review of PR #1853, round 5, point 3)
    RAISE WARNING 'anchors unit of note % was over its bound of % bytes: the words of % lost, % maybe and % valid anchors were given up', p_note, anchor_unit_bytes_max(), v_lost, v_maybe, v_valid
      USING HINT = 'anchor_words_given_up';
    v := note_anchor_places_of(p_ws, p_note, v_h);
  END IF;
  INSERT INTO note_anchor_places (note_id, workspace_id, places) VALUES (p_note, p_ws, jsonb_build_object('h', v_h, 'a', v))
    ON CONFLICT (note_id) DO UPDATE SET places = EXCLUDED.places WHERE note_anchor_places.places IS DISTINCT FROM EXCLUDED.places;
END;
$$ LANGUAGE plpgsql;
-- After every statement that wrote anchor rows, once for each note the statement touched (its transition tables), whatever order the rows came in: the note's unit
-- from its rows as they stand (review of PR #1853, round 4, point 2: a row trigger deferred to COMMIT wrote a note's unit again for every row whenever the rows of
-- several notes came interleaved, 20 times per note for a statement over 500 notes). A transaction whose statements write a note's anchors twice writes its unit twice;
-- the last write is the one that stays, and each is one row and one stamp. A merge or a snapshot import writes the rows from the unit instead and is skipped.
CREATE OR REPLACE FUNCTION note_anchor_places_follow() RETURNS trigger AS $$
DECLARE r record; v_notes uuid[]; v_ws uuid[];
BEGIN
  -- each branch names only the transition tables its event has (a query is planned when it runs)
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(n.note_id), array_agg(n.workspace_id) INTO v_notes, v_ws FROM (SELECT DISTINCT workspace_id, note_id FROM new_rows) n;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(n.note_id), array_agg(n.workspace_id) INTO v_notes, v_ws FROM (SELECT DISTINCT workspace_id, note_id FROM old_rows) n;
  ELSE
    SELECT array_agg(n.note_id), array_agg(n.workspace_id) INTO v_notes, v_ws
      FROM (SELECT DISTINCT workspace_id, note_id FROM new_rows UNION SELECT DISTINCT workspace_id, note_id FROM old_rows) n;
  END IF;
  FOR r IN SELECT DISTINCT x.w, x.n FROM unnest(v_ws, v_notes) AS x(w, n) WHERE NOT sync_import_active(x.w) LOOP
    PERFORM note_anchor_places_write(r.w, r.n);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS block_anchors_unit_follows ON block_anchors; -- the deferred row trigger of an earlier draft of this migration
CREATE OR REPLACE TRIGGER block_anchors_unit_follows_insert AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION note_anchor_places_follow();
CREATE OR REPLACE TRIGGER block_anchors_unit_follows_update AFTER UPDATE ON block_anchors REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION note_anchor_places_follow();
CREATE OR REPLACE TRIGGER block_anchors_unit_follows_delete AFTER DELETE ON block_anchors REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION note_anchor_places_follow();

-- The unit and the rows never disagree in silence. Two checks, one each way, so a fault in either of the two functions above is caught by the other:
--   on the node that writes (a deferred constraint trigger on note_anchor_places, skipped by a merge or an import): every entry of the unit as written makes its row exactly
--   (note_anchor_place), and every row of the note has an entry (rows -> unit -> rows; one pass over the note's rows, a FULL JOIN of the unit's entries with them);
--   on the node that takes a bundle (note_anchor_places_expand_all, after it wrote the rows): the rows give back the chosen head, for every anchor this node holds
--   (unit -> rows -> unit, note_anchor_entry).
-- Raises `anchor_unit_not_rows` (SQLSTATE OD215).
CREATE OR REPLACE FUNCTION note_anchor_places_is_rows() RETURNS trigger AS $$
DECLARE v_now jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  -- a unit written twice in one transaction (two statements wrote the note's anchors) queues this check twice: the version a later write replaced, or a unit removed
  -- since, is not the one that stays, and the later write's own check looks at the one that does
  SELECT places INTO v_now FROM note_anchor_places WHERE note_id = NEW.note_id;
  IF v_now IS NULL OR v_now IS DISTINCT FROM NEW.places THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM (SELECT * FROM block_anchors b WHERE b.workspace_id = NEW.workspace_id AND b.note_id = NEW.note_id) a
               FULL JOIN jsonb_each(NEW.places->'a') e ON e.key = a.anchor_id
               LEFT JOIN LATERAL note_anchor_place(e.value, NULL, a.quote, a.quote_prefix, a.quote_suffix, NEW.places->>'h') x ON true
              WHERE e.key IS NULL OR a.anchor_id IS NULL
                 OR (a.from_utf16, a.to_utf16, a.status, a.candidate_from_utf16, a.candidate_to_utf16, a.recovery_pending, a.quote, a.quote_prefix, a.quote_suffix, a.at_body_hash)
                    IS DISTINCT FROM (x.from_utf16, x.to_utf16, x.status, x.candidate_from_utf16, x.candidate_to_utf16, x.recovery_pending, x.quote, x.quote_prefix, x.quote_suffix, x.at_body_hash)) THEN
    RAISE EXCEPTION 'the anchors unit of note % is not its anchor rows', NEW.note_id USING ERRCODE = 'OD215', HINT = 'anchor_unit_not_rows', DETAIL = NEW.note_id::text;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS note_anchor_places_is_rows ON note_anchor_places;
CREATE CONSTRAINT TRIGGER note_anchor_places_is_rows AFTER INSERT OR UPDATE ON note_anchor_places DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION note_anchor_places_is_rows();

-- The receiving side, once for a whole bundle: `p_items` = [{"n": note, "p": the chosen head or null, "h": the body the rows are measured on, "w": {anchor id: [quote,
-- prefix, suffix]} for the anchors the head does not name}] (spine/stampedMerge/dbUnits.ts expandAnchorUnits). Every anchor row of those notes is written as
-- note_anchor_place makes it (only rows that change), then checked to give each chosen head back.
CREATE OR REPLACE FUNCTION note_anchor_places_expand_all(p_ws uuid, p_items jsonb) RETURNS void AS $$
BEGIN
  UPDATE block_anchors a SET (from_utf16, to_utf16, status, candidate_from_utf16, candidate_to_utf16, recovery_pending, quote, quote_prefix, quote_suffix, at_body_hash) =
      (SELECT x.from_utf16, x.to_utf16, x.status, x.candidate_from_utf16, x.candidate_to_utf16, x.recovery_pending, x.quote, x.quote_prefix, x.quote_suffix, x.at_body_hash
         FROM note_anchor_place(i.p->'a'->a.anchor_id, i.w->a.anchor_id, a.quote, a.quote_prefix, a.quote_suffix, i.h) x)
    FROM jsonb_to_recordset(p_items) AS i(n uuid, p jsonb, h text, w jsonb)
   WHERE a.workspace_id = p_ws AND a.note_id = i.n
     AND ROW(a.from_utf16, a.to_utf16, a.status, a.candidate_from_utf16, a.candidate_to_utf16, a.recovery_pending, a.quote, a.quote_prefix, a.quote_suffix, a.at_body_hash)
         IS DISTINCT FROM (SELECT ROW(x.from_utf16, x.to_utf16, x.status, x.candidate_from_utf16, x.candidate_to_utf16, x.recovery_pending, x.quote, x.quote_prefix, x.quote_suffix, x.at_body_hash)
                             FROM note_anchor_place(i.p->'a'->a.anchor_id, i.w->a.anchor_id, a.quote, a.quote_prefix, a.quote_suffix, i.h) x);
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_items) AS i(n uuid, p jsonb, h text, w jsonb)
               CROSS JOIN LATERAL jsonb_each(i.p->'a') e
               JOIN block_anchors r ON r.workspace_id = p_ws AND r.anchor_id = e.key AND r.note_id = i.n
              WHERE i.p IS NOT NULL
                AND note_anchor_entry(r.from_utf16, r.to_utf16, r.status, r.candidate_from_utf16, r.candidate_to_utf16, r.recovery_pending, r.quote, r.quote_prefix,
                                      r.quote_suffix, r.at_body_hash, i.p->>'h') IS DISTINCT FROM e.value) THEN
    RAISE EXCEPTION 'the anchors unit of a note is not its anchor rows' USING ERRCODE = 'OD215', HINT = 'anchor_unit_not_rows';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- The hash an anchor is written with is the body of the write that placed it (proposal §3.1: "at_body_hash = the body's hash").
-- Checked once per statement (a save writes all of a note's anchors in one statement), for the rows that WRITE the hash: every inserted row; an updated row whose
-- at_body_hash or note_id changed (paired with its old row by anchor_id); a row whose anchor_id changed (renameAnchor, the `^id` conversion) only when its (note, hash) is
-- not one an updated row of the same statement had before: a rename writes no hash. The body's hash is worked out once per version of a note in a transaction: keyed by the
-- note row's ctid, which every update of the note changes, kept in one transaction-local setting, the last note's (onden.anchor_body_last).
CREATE OR REPLACE FUNCTION block_anchor_body_hash(p_note uuid) RETURNS text AS $$
DECLARE v_ctid text; v_cached text; v_hash text;
BEGIN
  SELECT ctid::text INTO v_ctid FROM content_nodes WHERE id = p_note;
  IF v_ctid IS NULL THEN RETURN NULL; END IF;
  v_cached := current_setting('onden.anchor_body_last', true);
  IF v_cached IS NOT NULL AND split_part(v_cached, '|', 1) = p_note::text AND split_part(v_cached, '|', 2) = v_ctid THEN RETURN split_part(v_cached, '|', 3); END IF;
  SELECT encode(sha256(convert_to(COALESCE(markdown, ''), 'UTF8')), 'hex') INTO v_hash FROM content_nodes WHERE id = p_note;
  PERFORM set_config('onden.anchor_body_last', p_note::text || '|' || v_ctid || '|' || v_hash, true);
  RETURN v_hash;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION block_anchors_hash_is_body() RETURNS trigger AS $$
DECLARE bad uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    WITH written AS (SELECT DISTINCT n.note_id, n.at_body_hash FROM new_rows n WHERE NOT sync_import_active(n.workspace_id))
    SELECT w.note_id INTO bad FROM written w WHERE w.at_body_hash IS DISTINCT FROM block_anchor_body_hash(w.note_id) LIMIT 1;
  ELSE
    WITH written AS (
      SELECT DISTINCT n.note_id, n.at_body_hash FROM new_rows n
       WHERE NOT sync_import_active(n.workspace_id)
         AND NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.workspace_id = n.workspace_id AND o.anchor_id = n.anchor_id AND o.note_id = n.note_id AND o.at_body_hash = n.at_body_hash)
         AND (EXISTS (SELECT 1 FROM old_rows o WHERE o.workspace_id = n.workspace_id AND o.anchor_id = n.anchor_id)
              OR NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.workspace_id = n.workspace_id AND o.note_id = n.note_id AND o.at_body_hash = n.at_body_hash)))
    SELECT w.note_id INTO bad FROM written w WHERE w.at_body_hash IS DISTINCT FROM block_anchor_body_hash(w.note_id) LIMIT 1;
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'an anchor of note % was written with the hash of another body than the note''s', bad USING ERRCODE = 'OD215', HINT = 'anchor_hash_not_body', DETAIL = bad::text;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER block_anchors_hash_is_body_insert AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION block_anchors_hash_is_body();
CREATE OR REPLACE TRIGGER block_anchors_hash_is_body_update AFTER UPDATE ON block_anchors REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION block_anchors_hash_is_body();

-- 2. block_nodes -------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER block_nodes_sync_stamp_insert AFTER INSERT ON block_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_nodes', 'id', 'via:note_id', 'note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags', '', '', '');
CREATE OR REPLACE TRIGGER block_nodes_sync_stamp_update AFTER UPDATE ON block_nodes FOR EACH ROW
  WHEN ((OLD.note_id, OLD.anchor_id, OLD.block_ref, OLD.task_id, OLD.detached_note_id, OLD.detached_tags)
        IS DISTINCT FROM (NEW.note_id, NEW.anchor_id, NEW.block_ref, NEW.task_id, NEW.detached_note_id, NEW.detached_tags))
  EXECUTE FUNCTION sync_stamp_trigger('block_nodes', 'id', 'via:note_id', 'note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags', '', '', '');

-- 2c. what goes with its note (review of PR #1853, round 6, points 2 and 3) -----------------------------------------------------------------------------------------------
-- ONE rule for the three tables (spine/stampedMerge/dbUnits.ts `goesWithNote`): a row whose note is not on this node goes with it.
--   * a row made in that note (its `note` never written since: no stamp of its own) goes with no trace: its stamps and their heads are removed. Every node that holds it
--     holds it in that note, so the note's tombstone says it went; a received cascade does the same on every node. An anchors unit (keyed by its note) is always this.
--   * a row moved into that note (its `note` has a stamp of its own) keeps its stamps: they are the one record that it went, for a node that still holds it where it was
--     (that node removes the row when the move reaches it: dbRows.ts, the same rule). They carry no text of the note (an anchor's or a paragraph row's ids).
--   * a row deleted while its note is here is a delete as any other: its tombstone (sync_stamp_row_deleted, what sync_stamp_trigger does for a deleted row).
-- One statement trigger per table (transition table), so a note's rows cost one statement, not one trigger call per row (a space purged at once is one DELETE).
-- A stamp kept without its row keeps the value it wrote (review of PR #1853, round 8): sync_stamps.kept_value, `{"text": …}` the unit's text as sync_logged_value
-- gives it (the trigger's argument names the columns, the same list as the stamp trigger's), NULL where the row's column holds it. A head keeps its value as it always
-- did; `valueless` marks a head (a copy of a write) that came without one, which a merge never writes into a column (spine/stampedMerge/unit.ts `valueless`). Adding
-- them rewrites no row (a NULL and a constant default).
ALTER TABLE sync_stamps ADD COLUMN IF NOT EXISTS kept_value jsonb;
ALTER TABLE sync_stamp_heads ADD COLUMN IF NOT EXISTS valueless boolean NOT NULL DEFAULT false;
-- A kept value is the stamp's while that stamp is the unit's: a write made here replaces the stamp (a new origin or number), and its value is the row's column again.
-- The merge writes kept values itself (the stamp triggers stand aside), so this clears only on the node that writes. Review of PR #1853, round 9, point 1: a
-- column a foreign key emptied keeps its id on the stamp, on a row that is here, so the next write of that unit must not leave the old id behind.
-- Where a stamp may keep a value at all (review of PR #1853, round 9, point 2): the tables whose rows go with their note (ids, and a paragraph's detached state)
-- and the units a foreign key empties (an id). Nowhere else: a row of another table that is not here, because its note or space was deleted for good, keeps no text.
-- The same lists as spine/stampedMerge/dbUnits.ts `goesWithNote` and `clearedOnDelete` (stampedBundleSources.integration.test.ts compares them).
CREATE OR REPLACE FUNCTION sync_stamp_may_keep_value(p_label text, p_field text) RETURNS boolean AS $$
  SELECT p_label IN ('block_anchors', 'block_nodes', 'note_anchor_places')
      OR (p_label, p_field) IN (('content_nodes', 'parent'), ('spaces', 'owner'), ('rss_subscriptions', 'auto_tag'), ('rss_subscriptions', 'default_parent'));
$$ LANGUAGE sql IMMUTABLE;
ALTER TABLE sync_stamps DROP CONSTRAINT IF EXISTS sync_stamps_kept_value_where;
ALTER TABLE sync_stamps ADD CONSTRAINT sync_stamps_kept_value_where
  CHECK (kept_value IS NULL OR NOT (kept_value ? 'text') OR sync_stamp_may_keep_value(table_name, field)) NOT VALID;
-- A unit a foreign key empties (spine/stampedMerge/dbUnits.ts `clearedOnDelete`): when the row it names is deleted and the database empties the column, and no
-- stamp is written for that (a merge's triggers stand aside; a paragraph row's stamps are filed under its note, which the same statement may have deleted first), the
-- id stays on the unit's stamp, as its write said it (review of PR #1853, round 9, point 1: one statement deletes a note and the task under it, and whether the row
-- still named its task when it went depended on the order; the receiver deletes one note at a time in key order). One rule on the node that writes and the node that
-- merges. A unit with its own stamp row keeps the id there; one that follows its row's creation gets the stamp row a kept value needs (a copy of the creation's
-- stamp, empty saw: what storeUnit writes). An emptying that IS stamped (a local write over a row whose note is here) is a write of its own and keeps nothing.
-- Arguments: label, key column, workspace column, the note column whose absence means no stamp ('' when stamps never depend on it),
-- 'field:column:spec:named table:named column,…' (the guard compares them with the foreign keys of the catalog and dbUnits.ts clearedOnDelete).
CREATE OR REPLACE FUNCTION sync_keep_emptied_id() RETURNS trigger AS $$
DECLARE e text; v_field text; v_col text; v_spec text; v_reft text; v_refc text; v_ref text; v_ws uuid; v_key text; v_gone boolean; v_old text; v_note uuid;
BEGIN
  v_ws := sync_column(OLD, TG_ARGV[2])::uuid;
  -- first what costs nothing: an emptying that IS stamped is a write of its own, so on the node that writes nothing is kept unless the row's stamps could not be
  -- written (its note is gone: one primary-key look-up). A person's「取消任務」 or a move to the top level returns here (review of PR #1853, round 10, point 1).
  IF NOT sync_import_active(v_ws) THEN
    IF TG_ARGV[3] = '' THEN RETURN NULL; END IF;
    -- the id taken first: sync_column is volatile, and a volatile call in the predicate is no index key (the scan stops at the first match, wherever it is)
    v_note := sync_column(OLD, TG_ARGV[3])::uuid;
    IF EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = v_note) THEN RETURN NULL; END IF;
  END IF;
  v_key := sync_column(OLD, TG_ARGV[1]);
  FOREACH e IN ARRAY string_to_array(TG_ARGV[4], ',') LOOP
    v_field := split_part(e, ':', 1); v_col := split_part(e, ':', 2); v_spec := split_part(e, ':', 3); v_reft := split_part(e, ':', 4); v_refc := split_part(e, ':', 5);
    v_ref := sync_column(OLD, v_col);
    IF v_ref IS NULL OR sync_column(NEW, v_col) IS NOT NULL THEN CONTINUE; END IF;
    -- emptied by the foreign key (the row it names is gone), not written NULL by someone: one look-up on the named table's key, compared as its own type
    EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM %I WHERE %I = $1::%s)', v_reft, v_refc, (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = v_reft::regclass AND a.attname = v_refc))
      INTO STRICT v_gone USING v_ref;
    IF NOT v_gone THEN CONTINUE; END IF;
    v_old := sync_logged_value(OLD, v_field, v_spec);
    UPDATE sync_stamps SET kept_value = jsonb_build_object('text', v_old)
     WHERE workspace_id = v_ws AND table_name = TG_ARGV[0] AND row_key = v_key AND field = v_field AND NOT deleted AND kept_value IS NULL;
    IF NOT FOUND THEN
      INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta, kept_value)
      SELECT v_ws, TG_ARGV[0], v_key, v_field, c.origin, c.seq, c.hlc_wall, c.hlc_counter, c.author, c.device, false, '{}'::jsonb, NULL, jsonb_build_object('text', v_old)
        FROM sync_stamps c WHERE c.workspace_id = v_ws AND c.table_name = TG_ARGV[0] AND c.row_key = v_key AND c.field = '*' AND NOT c.deleted
      ON CONFLICT (workspace_id, table_name, row_key, field) DO NOTHING;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER block_nodes_keep_emptied_id AFTER UPDATE OF task_id, detached_note_id ON block_nodes FOR EACH ROW
  WHEN ((OLD.task_id IS NOT NULL AND NEW.task_id IS NULL) OR (OLD.detached_note_id IS NOT NULL AND NEW.detached_note_id IS NULL))
  EXECUTE FUNCTION sync_keep_emptied_id('block_nodes', 'id', 'workspace_id', 'note_id', 'task:task_id:task_id:content_nodes:id,detached:detached_note_id:detached_note_id+detached_tags:content_nodes:id');
CREATE OR REPLACE TRIGGER content_nodes_keep_emptied_id AFTER UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS NOT NULL AND NEW.parent_id IS NULL)
  EXECUTE FUNCTION sync_keep_emptied_id('content_nodes', 'id', 'workspace_id', '', 'parent:parent_id:parent_id:content_nodes:id');
CREATE OR REPLACE TRIGGER spaces_keep_emptied_id AFTER UPDATE OF owner_actor_id ON spaces FOR EACH ROW
  WHEN (OLD.owner_actor_id IS NOT NULL AND NEW.owner_actor_id IS NULL)
  EXECUTE FUNCTION sync_keep_emptied_id('spaces', 'id', 'workspace_id', '', 'owner:owner_actor_id:owner_actor_id:actors:id');
CREATE OR REPLACE TRIGGER rss_subscriptions_keep_emptied_id AFTER UPDATE OF auto_tag_id, default_parent_id ON rss_subscriptions FOR EACH ROW
  WHEN ((OLD.auto_tag_id IS NOT NULL AND NEW.auto_tag_id IS NULL) OR (OLD.default_parent_id IS NOT NULL AND NEW.default_parent_id IS NULL))
  EXECUTE FUNCTION sync_keep_emptied_id('rss_subscriptions', 'id', 'workspace_id', '', 'auto_tag:auto_tag_id:auto_tag_id:content_nodes:id,default_parent:default_parent_id:default_parent_id:content_nodes:id');
CREATE OR REPLACE FUNCTION sync_stamps_kept_value_cleared() RETURNS trigger AS $$
BEGIN
  IF NOT sync_import_active(NEW.workspace_id) THEN NEW.kept_value := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER sync_stamps_kept_value_cleared BEFORE UPDATE ON sync_stamps FOR EACH ROW
  WHEN (OLD.kept_value IS NOT NULL AND (OLD.origin, OLD.seq) IS DISTINCT FROM (NEW.origin, NEW.seq))
  EXECUTE FUNCTION sync_stamps_kept_value_cleared();
CREATE OR REPLACE FUNCTION sync_stamp_row_deleted(p_ws uuid, p_table text, p_key text) RETURNS void AS $$
DECLARE v_seen jsonb;
BEGIN
  -- sync_stamp_trigger's DELETE branch (migration 206), for a table whose delete is a statement trigger: the same steps in the same order, so a merge (which writes no
  -- stamp, sync_stamp_put_over) clears what it cleared before
  v_seen := sync_row_seen(p_ws, p_table, p_key);
  DELETE FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field <> '*';
  DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field <> '*';
  PERFORM sync_stamp_put_over(p_ws, p_table, p_key, '*', true, sync_stamp_current(p_ws), NULL, false, v_seen);
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION sync_rows_go_with_note() RETURNS trigger AS $$
DECLARE r record; v_keys text[]; v_notes uuid[]; v_ws uuid[]; v_gone text[]; v_ws1 uuid; v_cols jsonb;
BEGIN
  -- the units' columns, as the stamp trigger names them ('note=note_id,anchor=anchor_id,…')
  SELECT jsonb_object_agg(split_part(p, '=', 1), split_part(p, '=', 2)) INTO v_cols FROM unnest(string_to_array(TG_ARGV[0], ',')) AS p;
  IF TG_TABLE_NAME = 'block_anchors' THEN SELECT array_agg(o.anchor_id), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN SELECT array_agg(o.id::text), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  ELSE SELECT array_agg(o.note_id::text), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  END IF;
  IF v_keys IS NULL THEN RETURN NULL; END IF;
  -- deleted while the note is here: a tombstone each (a save retires a few anchors; a merge applies a received tombstone)
  FOR r IN SELECT n.workspace_id AS w, x.k FROM unnest(v_keys, v_notes) AS x(k, n) JOIN content_nodes n ON n.id = x.n LOOP
    PERFORM sync_stamp_row_deleted(r.w, TG_TABLE_NAME, r.k);
  END LOOP;
  -- gone with their note: those made in it leave nothing; those moved into it keep their stamps (above)
  FOR v_ws1 IN SELECT DISTINCT w FROM unnest(v_ws) AS w LOOP
    SELECT array_agg(x.k) INTO v_gone FROM unnest(v_keys, v_notes, v_ws) AS x(k, n, w)
     WHERE x.w = v_ws1 AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = x.n)
       AND NOT EXISTS (SELECT 1 FROM sync_stamps s WHERE s.workspace_id = v_ws1 AND s.table_name = TG_TABLE_NAME AND s.row_key = x.k AND s.field = 'note');
    IF v_gone IS NOT NULL THEN
      DELETE FROM sync_stamps s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = TG_TABLE_NAME AND s.row_key = g.k;
      DELETE FROM sync_stamp_heads s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = TG_TABLE_NAME AND s.row_key = g.k;
    END IF;
  END LOOP;
  -- those moved into it keep each stamp's value: the row was the one place that held the winners' (a transition table's row is an anonymous record: made the table's
  -- row type again for sync_logged_value)
  IF TG_TABLE_NAME = 'block_anchors' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_anchors, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = TG_TABLE_NAME AND s.row_key = o.anchor_id AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_nodes, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = TG_TABLE_NAME AND s.row_key = o.id::text AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  END IF; -- an anchors unit is keyed by its note: it never moves into another, so nothing of it is kept
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- A key made again (an anchor id adopted into a note after its row went with another note, keeping its stamps): the fields follow the new creation, as for a key never
-- made before. On the node that writes; a merge writes the units it decided itself.
CREATE OR REPLACE FUNCTION sync_rows_made_afresh() RETURNS trigger AS $$
DECLARE v_keys text[]; v_ws uuid[];
BEGIN
  IF TG_TABLE_NAME = 'block_anchors' THEN SELECT array_agg(n.anchor_id), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN SELECT array_agg(n.id::text), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  ELSE SELECT array_agg(n.note_id::text), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  END IF;
  IF v_keys IS NULL THEN RETURN NULL; END IF;
  -- the new creation says which of the key's old field writes it was made over (`meta.seen`, what a creation over a delete says: store.ts droppedBySeen), so every
  -- node drops the same ones, not only this one (review of PR #1853, round 9, point 5 c: the other node kept them as heads beside the new values)
  -- merged, origin by origin, with what the creation already said it was made over (a delete's `seen` it carries: migration 206), never in place of it
  UPDATE sync_stamps s SET meta = COALESCE(s.meta, '{}'::jsonb) || jsonb_build_object('seen', (
           SELECT jsonb_object_agg(z.origin, z.m) FROM (SELECT y.origin, max(y.seq) AS m FROM (
             SELECT e.key AS origin, e.value::bigint AS seq FROM jsonb_each_text(COALESCE(s.meta -> 'seen', '{}'::jsonb)) e
             UNION ALL SELECT e.key, e.value::bigint FROM jsonb_each_text(o.seen) e) y GROUP BY y.origin) z))
    FROM (SELECT u.w, u.k, jsonb_object_agg(u.origin, u.m) AS seen FROM (
            SELECT x.w, x.k, t.origin, max(t.seq) AS m FROM unnest(v_ws, v_keys) AS x(w, k)
              JOIN (SELECT workspace_id, row_key, origin, seq FROM sync_stamps WHERE table_name = TG_TABLE_NAME AND field <> '*' AND origin <> 'genesis'
                    UNION ALL SELECT workspace_id, row_key, origin, seq FROM sync_stamp_heads WHERE table_name = TG_TABLE_NAME AND field <> '*' AND origin <> 'genesis') t
                ON t.workspace_id = x.w AND t.row_key = x.k
             GROUP BY x.w, x.k, t.origin) u GROUP BY u.w, u.k) o
   WHERE s.workspace_id = o.w AND s.table_name = TG_TABLE_NAME AND s.row_key = o.k AND s.field = '*' AND NOT s.deleted;
  DELETE FROM sync_stamps s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = TG_TABLE_NAME AND s.row_key = x.k AND s.field <> '*';
  DELETE FROM sync_stamp_heads s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = TG_TABLE_NAME AND s.row_key = x.k AND s.field <> '*';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- A row's workspace is its note's (review of PR #1853, round 6, point 5): the stamp triggers file a row under its note's workspace and every read takes the row's own
-- column, so the two must not differ. Nothing in the schema binds them (content_nodes has no unique (workspace_id, id) to point a foreign key at), so the writes do:
-- every row made or changed, on any node and from a merge too (OD215, which a merge refuses as bundle_malformed).
CREATE OR REPLACE FUNCTION sync_rows_in_their_notes_workspace() RETURNS trigger AS $$
DECLARE bad text;
BEGIN
  SELECT x.note_id::text INTO bad FROM (SELECT DISTINCT n.note_id, n.workspace_id FROM new_rows n) x JOIN content_nodes c ON c.id = x.note_id WHERE c.workspace_id <> x.workspace_id LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'a row of % is in another workspace than its note %', TG_TABLE_NAME, bad USING ERRCODE = 'OD215', HINT = 'row_not_in_its_notes_workspace', DETAIL = bad;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- ...and a note never changes workspace (review of PR #1853, round 7, point 7): no writer of this repository does it; this is the guard, so the rows' check above cannot
-- be undone from the note's side.
CREATE OR REPLACE FUNCTION content_nodes_workspace_is_fixed() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a note does not move to another workspace (note %)', OLD.id USING ERRCODE = 'OD215', HINT = 'note_workspace_is_fixed', DETAIL = OLD.id::text;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_workspace_is_fixed BEFORE UPDATE OF workspace_id ON content_nodes FOR EACH ROW
  WHEN (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id) EXECUTE FUNCTION content_nodes_workspace_is_fixed();
CREATE OR REPLACE TRIGGER block_anchors_in_notes_workspace_insert AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER block_nodes_in_notes_workspace_insert AFTER INSERT ON block_nodes REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER note_anchor_places_in_notes_workspace_insert AFTER INSERT ON note_anchor_places REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
-- an UPDATE trigger with a transition table cannot name columns (UPDATE OF): the check looks each note of the statement up once (a save: one note)
CREATE OR REPLACE TRIGGER block_anchors_in_notes_workspace_update AFTER UPDATE ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER block_nodes_in_notes_workspace_update AFTER UPDATE ON block_nodes REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER note_anchor_places_in_notes_workspace_update AFTER UPDATE ON note_anchor_places REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
DROP TRIGGER IF EXISTS block_anchors_sync_stamp_delete ON block_anchors; -- the row triggers of an earlier draft of this migration (round 5)
DROP TRIGGER IF EXISTS block_nodes_sync_stamp_delete ON block_nodes;
DROP TRIGGER IF EXISTS note_anchor_places_sync_stamp_delete ON note_anchor_places;
CREATE OR REPLACE TRIGGER block_anchors_go_with_note AFTER DELETE ON block_anchors REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_go_with_note('note=note_id');
CREATE OR REPLACE TRIGGER block_nodes_go_with_note AFTER DELETE ON block_nodes REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_go_with_note('note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags');
CREATE OR REPLACE TRIGGER note_anchor_places_go_with_note AFTER DELETE ON note_anchor_places REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_go_with_note('places=places');
CREATE OR REPLACE TRIGGER block_anchors_made_afresh AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_made_afresh();
CREATE OR REPLACE TRIGGER block_nodes_made_afresh AFTER INSERT ON block_nodes REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_made_afresh();
CREATE OR REPLACE TRIGGER note_anchor_places_made_afresh AFTER INSERT ON note_anchor_places REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_made_afresh();

-- 2b. a restored server's renewal (migration 213) holds its old id up to its last number for every label a change bundle carries. The list is its own function now,
-- sync_carried_labels(): a migration that adds a label redefines only that one (review of PR #1853, round 2), and the renewal reads it. sync_renew_node_id() is 213's
-- word for word but for that one read; it still takes the new id only through sync_take_node_id() (guards/restoreRenewsNodeId.guard.test.ts).
CREATE OR REPLACE FUNCTION sync_carried_labels() RETURNS text[] AS $$
  SELECT ARRAY['workspaces', 'spaces', 'space_members', 'content_nodes', 'node_attributes', 'node_tags', 'node_edges', 'note_pointers', 'node_positions', 'note_anchor_places', 'block_anchors', 'block_nodes', 'block_node_tags', 'function_refs', 'rss_subscriptions', 'rss_mutes', 'external_calendars', 'actor_module_settings', 'content_nodes.tag_schema', 'spaces.capabilities', 'function_refs.config', 'workspaces.modules_off', 'workspaces.modules_confirmed']::text[];
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION sync_renew_node_id() RETURNS TABLE (old_node_id text, new_node_id text, workspaces bigint, origins_added bigint) AS $$
DECLARE v_ws uuid; v_old text; v_new text; v_clocks bigint; v_origins bigint;
BEGIN
  -- every writer takes a workspace's event-append lock, then its clock row (spine/stamps.ts); a renewal takes all of them, in one order
  FOR v_ws IN SELECT c.workspace_id FROM sync_clock c ORDER BY c.workspace_id LOOP
    PERFORM 1 FROM sync_lock_clock(v_ws);
  END LOOP;
  SELECT t.before_id, t.after_id INTO v_old, v_new FROM sync_take_node_id() t;
  -- the old id's own writes, as an origin held up to the last number it gave (before the clock is renumbered below)
  IF v_old IS NOT NULL THEN
    -- held up to that number for every label a change bundle carries: the same shape as spine/stampedBundle.ts haveOfAll, from the one list
    -- spine/stampedMerge/dbUnits.ts CARRIED_LABELS, as sync_carried_labels() names them (restoreRenewsNodeId.guard.test.ts keeps the two equal)
    INSERT INTO sync_origins (workspace_id, origin, vouched_by, have)
    SELECT c.workspace_id, v_old, 'self-restore', (SELECT jsonb_object_agg(l, c.next_seq - 1) FROM unnest(sync_carried_labels()) AS l)
      FROM sync_clock c WHERE c.next_seq > 1;
    GET DIAGNOSTICS v_origins = ROW_COUNT;
  ELSE
    v_origins := 0;
  END IF;
  WITH top AS (
    SELECT s.workspace_id, s.hlc_wall, s.hlc_counter FROM sync_stamps s
    UNION ALL SELECT h.workspace_id, h.hlc_wall, h.hlc_counter FROM sync_stamp_heads h
  ), best AS (
    SELECT DISTINCT ON (workspace_id) workspace_id, hlc_wall, hlc_counter FROM top ORDER BY workspace_id, hlc_wall DESC, hlc_counter DESC
  )
  UPDATE sync_clock c SET next_seq = 1,
         hlc_wall = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_wall ELSE c.hlc_wall END,
         hlc_counter = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_counter ELSE c.hlc_counter END
    FROM sync_clock c2 LEFT JOIN best b ON b.workspace_id = c2.workspace_id
   WHERE c2.workspace_id = c.workspace_id;
  GET DIAGNOSTICS v_clocks = ROW_COUNT;
  RETURN QUERY SELECT v_old, v_new, v_clocks, v_origins;
END;
$$ LANGUAGE plpgsql;
-- 217: a temporary session's actors row is never deleted, and keeps its id, workspace and type, while its workspace exists (db/migrations/217_keep_session_actor_rows.sql)
CREATE OR REPLACE FUNCTION actors_keep_session_row() RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public.actors WHERE type = 'session') THEN
      RAISE EXCEPTION 'a temporary session''s actors row is kept: actors cannot be truncated while one exists'
        USING ERRCODE = 'restrict_violation', HINT = 'a session is ended (services/participantSessions.ts), never removed';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.type = 'session' AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id) THEN
      RAISE EXCEPTION 'a temporary session''s actors row is kept: it is ended, never deleted'
        USING ERRCODE = 'restrict_violation', HINT = 'only deleting its whole workspace takes it';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF (OLD.type = 'session' OR NEW.type = 'session')
     AND (NEW.type IS DISTINCT FROM OLD.type OR NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    RAISE EXCEPTION 'a temporary session''s actors row keeps its id, workspace and type'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS actors_keep_session_row ON actors;
CREATE TRIGGER actors_keep_session_row BEFORE DELETE OR UPDATE OF id, workspace_id, type ON actors
  FOR EACH ROW EXECUTE FUNCTION actors_keep_session_row();

DROP TRIGGER IF EXISTS actors_keep_session_rows_truncate ON actors;
CREATE TRIGGER actors_keep_session_rows_truncate BEFORE TRUNCATE ON actors
  FOR EACH STATEMENT EXECUTE FUNCTION actors_keep_session_row();

ALTER TABLE actors ENABLE ALWAYS TRIGGER actors_keep_session_row;
ALTER TABLE actors ENABLE ALWAYS TRIGGER actors_keep_session_rows_truncate;
-- 218: a note's space follows its tree; the space a person wrote is a column of its own (db/migrations/218_space_follows_tree.sql)
-- 1. the column and the copy (before any trigger watches it)
-- (no foreign key: what a person wrote is replicated as it was written; a written space this node does not hold derives the workspace's default space,
-- the same on every node: src/spine/stampedMerge/dbRows.ts deriveNoteSpaces)
ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS written_space_id uuid;
-- (only while no trigger watches the new column, i.e. on the first run: run again by hand later, it would overwrite the space written for a note under a parent,
-- which may rightly differ from the one it is in, and the stamp trigger would stamp it)
UPDATE content_nodes SET written_space_id = space_id WHERE written_space_id IS DISTINCT FROM space_id
   AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_nodes_sync_stamp_space_root' AND tgrelid = 'content_nodes'::regclass);

-- A note is at the top when it has no parent or its parent is a tag (the same as src/spine/stampedMerge/rules/space.ts spacesOfTree, where the walk ends).
CREATE OR REPLACE FUNCTION content_nodes_at_top(p_parent uuid) RETURNS boolean AS $$
  SELECT p_parent IS NULL OR EXISTS (SELECT 1 FROM content_nodes p WHERE p.id = p_parent AND p.node_type = 'class_tag');
$$ LANGUAGE sql STABLE;

-- 2. the written space follows the space of a note at the top, on a write made here
CREATE OR REPLACE FUNCTION content_nodes_derive_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_space uuid;
  parent_type text;
  actor_space text;
  at_top boolean;
BEGIN
  IF NEW.node_type = 'class_tag' THEN
    NEW.space_id := NULL;
    NEW.written_space_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.space_id IS NULL THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT space_id, node_type INTO parent_space, parent_type FROM content_nodes WHERE id = NEW.parent_id;
      IF parent_type IS DISTINCT FROM 'class_tag' THEN NEW.space_id := parent_space; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      actor_space := NULLIF(current_setting('onden.actor_space', true), '');
      IF actor_space IS NOT NULL THEN NEW.space_id := actor_space::uuid; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      -- A background job (spine/systemJobs.ts; mutate() sets onden.system_actor)
      -- has no personal space: it names a parent or a space, or the create fails.
      IF current_setting('onden.system_actor', true) = 'on' THEN
        RAISE EXCEPTION 'a system job has no personal space: give the new note a parent or a space'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT id INTO NEW.space_id FROM spaces WHERE workspace_id = NEW.workspace_id AND is_default;
    END IF;
  END IF;
  -- a snapshot or a merge stores the written space as it was carried, NULL included (it is what the `space` unit says; the merge derives space_id itself,
  -- dbRows.ts deriveNoteSpaces)
  IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.written_space_id IS NULL THEN NEW.written_space_id := NEW.space_id; END IF;
    RETURN NEW;
  END IF;
  IF NEW.space_id IS NOT DISTINCT FROM OLD.space_id AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN RETURN NEW; END IF;
  at_top := content_nodes_at_top(NEW.parent_id);
  IF at_top THEN
    -- a note at the top before and after, whose space changes, is placed there (5. below stamps `parent` and `sort` with this write): the order key's stamp
    -- (migration 200 order_stamp, the tie rule among equal keys) becomes this write's, as order_stamp_follow_parent (209) does for a move
    IF NEW.space_id IS DISTINCT FROM OLD.space_id AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id AND content_nodes_at_top(OLD.parent_id)
       AND NEW.written_space_id IS DISTINCT FROM NEW.space_id THEN
      NEW.order_stamp := lpad(sync_stamp_current(NEW.workspace_id)->>'wall', 15, '0') || lpad(sync_stamp_current(NEW.workspace_id)->>'counter', 6, '0');
    END IF;
    NEW.written_space_id := NEW.space_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_nodes_derive_space ON content_nodes;
CREATE TRIGGER content_nodes_derive_space
  BEFORE INSERT OR UPDATE OF space_id, parent_id, node_type, written_space_id ON content_nodes
  FOR EACH ROW EXECUTE FUNCTION content_nodes_derive_space();

-- 3. the stamp triggers: `space` is the written space
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_update AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown
     OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.order_key IS DISTINCT FROM NEW.order_key
     OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR OLD.written_space_id IS DISTINCT FROM NEW.written_space_id
     OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');

-- 4. a note that comes to the top stamps the space it is in, with the write that put it there
CREATE OR REPLACE FUNCTION sync_stamp_space_with_root() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_stamp_put_row(NEW.workspace_id, 'content_nodes', NEW.id::text, 'space', false, sync_stamp_current(NEW.workspace_id), OLD, 'written_space_id');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_space_root AFTER UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id AND NEW.node_type <> 'class_tag' AND OLD.written_space_id IS NOT DISTINCT FROM NEW.written_space_id
        AND content_nodes_at_top(NEW.parent_id) AND NOT content_nodes_at_top(OLD.parent_id))
  EXECUTE FUNCTION sync_stamp_space_with_root();

-- 5. a note at the top whose space is written is PLACED there: the write also stamps its parent (the same value, at the top), as 209 stamps `sort` with `parent`.
-- A space and a parent are one place for a note at the top: a reparent made elsewhere without seeing this move is a concurrent write of the same unit, so the
-- later of the two wins and the other stays a conflict head its author can see. Without it, a move to another space lost to a reparent it never met with no
-- trace (the winning `space` of a note under a parent is not read).
-- A stamp of a unit of a note, with its value unchanged, BESIDE the unit's other heads (review of PR #1907, rounds 1 and 2, point 3 / point 2): the person moved the
-- note to another space and made no choice between the places two other writes gave it; sync_stamp_put_over, which takes every head as seen, would drop a head
-- nobody had looked at. Its `saw` is the unit's winner (with what the winner had seen), and, for a unit that follows its row's creation, every head of that
-- creation (as sync_stamp_put_over). A `saw` counts per origin (README "同一來源較晚的寫入一定看過它較早的"), so it also covers the heads of the winner's origin
-- older than the winner: every node that takes this stamp drops exactly the heads it covers (the core's `covers`, src/spine/stampedMerge/unit.ts), and so this
-- node drops the same ones here. The cost: a position the winner's own origin wrote earlier and lost counts as seen by this move (when the winner is this node's
-- own earlier move: this node's own lost drag; the winner can be another node's write whose `saw` already counted this node, and then this node's older head goes
-- too). A head of an origin the winner had not counted stays. Then the writer and every node that takes the stamp hold the same heads, and
-- taking it again, or everything again, changes nothing.
CREATE OR REPLACE FUNCTION sync_stamp_put_beside(p_ws uuid, p_key text, p_field text, s jsonb, p_old text) RETURNS void AS $$
DECLARE d record; h record; v_saw jsonb := '{}'::jsonb; v_meta jsonb;
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    IF d.origin = s->>'origin' AND d.seq = (s->>'seq')::bigint THEN RETURN; END IF; -- this transaction wrote the unit already
    IF d.origin = 'genesis' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0);
    ELSE v_saw := sync_saw_merge(d.saw, jsonb_build_object(d.origin, d.seq)); END IF;
  ELSE
    -- the field follows its row's creation (README "跟著 `*` 的欄位"), as sync_stamp_put_over reads it, with every head of that creation
    SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = '*';
    IF FOUND AND d.origin = 'genesis' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0);
    ELSIF FOUND AND NOT (d.origin = s->>'origin' AND d.seq = (s->>'seq')::bigint) THEN v_saw := jsonb_build_object(d.origin, d.seq); END IF;
    FOR h IN SELECT * FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = '*' AND origin <> 'genesis' LOOP
      IF NOT (h.origin = s->>'origin' AND h.seq = (s->>'seq')::bigint) THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object(h.origin, h.seq)); END IF;
    END LOOP;
  END IF;
  -- the heads this `saw` covers are gone on every node that takes the stamp (covers: a genesis head by its name, any other by seq <= saw[origin]): gone here too
  DELETE FROM sync_stamp_heads x WHERE x.workspace_id = p_ws AND x.table_name = 'content_nodes' AND x.row_key = p_key AND x.field = p_field
     AND CASE WHEN x.origin = 'genesis' THEN v_saw ? ('genesis:' || x.content_hash) ELSE x.seq <= COALESCE((v_saw->>x.origin)::bigint, -1) END;
  IF p_field = 'parent' THEN v_meta := jsonb_build_object('from', p_old); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, 'content_nodes', p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, false, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
END;
$$ LANGUAGE plpgsql;

-- a place is one write (209): `parent` and `sort` together, each beside its other heads
CREATE OR REPLACE FUNCTION sync_stamp_parent_with_space() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  s := sync_stamp_current(NEW.workspace_id);
  PERFORM sync_stamp_put_beside(NEW.workspace_id, NEW.id::text, 'parent', s, OLD.parent_id::text);
  PERFORM sync_stamp_put_beside(NEW.workspace_id, NEW.id::text, 'sort', s, OLD.order_key);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- (no column list: written_space_id is set by content_nodes_derive_space, not by the statement, and UPDATE OF fires only for columns the statement names)
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_parent_space AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.written_space_id IS DISTINCT FROM NEW.written_space_id AND OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id AND NEW.node_type <> 'class_tag'
        AND content_nodes_at_top(NEW.parent_id))
  EXECUTE FUNCTION sync_stamp_parent_with_space();

-- 6. a space's deletion: what a person wrote, and what is shown. spaces.deleted_at stays the column every read uses; `deleted` is now the written column.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS written_deleted_at timestamptz;
UPDATE spaces SET written_deleted_at = deleted_at WHERE written_deleted_at IS DISTINCT FROM deleted_at
   AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'spaces_written_deleted' AND tgrelid = 'spaces'::regclass);

-- the view: a space whose deletion is written is shown deleted only while no live note is in it (a live note there came by a write the deleter had not seen:
-- deleteSpace refuses a space with live notes, and no write that saw the deletion can put one there). One definition, called by the merge after its rows are in
-- (src/spine/stampedMerge/dbRows.ts storeMergedRows) and by the triggers below when a live note leaves such a space here. Returns how many rows it changed.
CREATE OR REPLACE FUNCTION spaces_show_deleted(p_ws uuid, p_ids uuid[]) RETURNS integer AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('onden.space_deleted_view', 'on', true);
  UPDATE spaces s SET deleted_at = v.shown
    FROM (SELECT x.id, CASE WHEN x.written_deleted_at IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM content_nodes c WHERE c.workspace_id = x.workspace_id AND c.space_id = x.id AND c.deleted_at IS NULL AND c.node_type <> 'class_tag')
                 THEN x.written_deleted_at END AS shown
            FROM spaces x WHERE x.workspace_id = p_ws AND x.id = ANY(p_ids)) v
   WHERE s.id = v.id AND s.deleted_at IS DISTINCT FROM v.shown;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('onden.space_deleted_view', '', true);
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- a write made here (not a snapshot, a merge or the view) that deletes or restores a space writes it
CREATE OR REPLACE FUNCTION spaces_written_deleted() RETURNS trigger AS $$
BEGIN
  IF current_setting('onden.space_deleted_view', true) = 'on' OR sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL) THEN NEW.written_deleted_at := NEW.deleted_at; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS spaces_written_deleted ON spaces;
CREATE TRIGGER spaces_written_deleted BEFORE INSERT OR UPDATE OF deleted_at ON spaces FOR EACH ROW EXECUTE FUNCTION spaces_written_deleted();

CREATE OR REPLACE TRIGGER spaces_sync_stamp_insert AFTER INSERT ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=written_deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_update AFTER UPDATE OF name, kind, owner_actor_id, deleted_at, written_deleted_at ON spaces FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR (OLD.written_deleted_at IS NULL) IS DISTINCT FROM (NEW.written_deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=written_deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_delete AFTER DELETE ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=written_deleted_at', '', '', '');

-- a person who deletes a space the view kept (its deletion was already written, the notes have left since) deletes it again: a write, stamped
CREATE OR REPLACE FUNCTION sync_stamp_space_deleted_again() RETURNS trigger AS $$
BEGIN
  IF current_setting('onden.space_deleted_view', true) = 'on' OR sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_stamp_put_row(NEW.workspace_id, 'spaces', NEW.id::text, 'deleted', false, sync_stamp_current(NEW.workspace_id), OLD, 'written_deleted_at');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER spaces_sync_stamp_deleted_again AFTER UPDATE OF deleted_at ON spaces FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND OLD.written_deleted_at IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_space_deleted_again();

-- a live note that leaves a space the view keeps by an UPDATE made here (moved out, put in the trash): the view is worked out again for that space. Only UPDATE:
-- a DELETE (a purge), a note that comes INTO such a space, and a restore are not worked out here; they are worked out at the next merge (README of
-- src/spine/stampedMerge, "接上傳輸前必須完成"). A change of the view here bumps no epoch and writes no event.
CREATE OR REPLACE FUNCTION content_nodes_left_kept_space() RETURNS trigger AS $$
DECLARE v record;
BEGIN
  FOR v IN
    SELECT o.workspace_id AS ws, array_agg(DISTINCT o.space_id) AS ids
      FROM old_rows o LEFT JOIN new_rows n ON n.id = o.id
      JOIN spaces s ON s.id = o.space_id AND s.written_deleted_at IS NOT NULL
     WHERE o.deleted_at IS NULL AND o.space_id IS NOT NULL AND (n.id IS NULL OR n.space_id IS DISTINCT FROM o.space_id OR n.deleted_at IS NOT NULL)
     GROUP BY o.workspace_id
  LOOP
    IF NOT sync_import_active(v.ws) THEN PERFORM spaces_show_deleted(v.ws, v.ids); END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_left_kept_space_update AFTER UPDATE ON content_nodes
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION content_nodes_left_kept_space();

-- 7. the notes a cut of a loop puts back under a note (src/spine/stampedMerge/dbRows.ts effectiveSubtree): found by their winning `parent` write's `meta.from`
CREATE INDEX IF NOT EXISTS sync_stamps_parent_from_idx ON sync_stamps (workspace_id, (meta->>'from'))
  WHERE table_name = 'content_nodes' AND field = 'parent' AND meta ? 'from';

-- 8. the tombstone of a note that goes for good says the space it was shown in (`meta.space`; review of PR #1907, round 3, point 1): a note left without its
-- parent by that (its parent column emptied by the foreign key, or a cut of a loop putting it back under the note that went) is in that space, on every node
-- (src/spine/stampedMerge/dbRows.ts derivedSpaces), not in the space once written for it, which an ancestor's move never updated. Fires after the stamp
-- trigger that wrote the tombstone (triggers fire by name); a snapshot or a merge stores the tombstone as carried.
CREATE OR REPLACE FUNCTION content_nodes_tombstone_space() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(OLD.workspace_id) THEN RETURN NULL; END IF;
  UPDATE sync_stamps SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('space', OLD.space_id::text)
   WHERE workspace_id = OLD.workspace_id AND table_name = 'content_nodes' AND row_key = OLD.id::text AND field = '*' AND deleted;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete_space AFTER DELETE ON content_nodes FOR EACH ROW
  WHEN (OLD.node_type <> 'class_tag' AND OLD.space_id IS NOT NULL)
  EXECUTE FUNCTION content_nodes_tombstone_space();
-- 220: a note's versions get an identity every node will share; the commit check that every local write minted its version (db/migrations/220_note_versions.sql)
CREATE TABLE IF NOT EXISTS note_versions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A note deleted for good takes its versions with it on every node (§6): the cascade, like ink_chunks.
  note_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  unit text NOT NULL CHECK (unit IN ('body', 'ink_data', 'board_ink', 'note_ink')),
  version_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'updated', 'restored', 'merged', 'baseline', 'set_aside', 'removed')),
  title text,
  -- body: blobs.hash; drawing: sha256 of the whole value (blobs, or ink_manifests of this note); NULL for a removed drawing.
  content_hash text,
  -- the time the minting node recorded, UTC microseconds `YYYY-MM-DDTHH:MM:SS.ffffffZ` (spine/importedHistory.ts IMPORTED_AT).
  at text NOT NULL,
  clock_wall bigint,
  clock_counter integer,
  -- the order inside one instant: s: its place among the transaction's writes of this unit; g: the event's rank by (created_at, id) (§4.4 point 3).
  ordinal integer NOT NULL,
  -- this node's record, not the identity (§2.5): the node that minted or first received it.
  recorded_by text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('person', 'ai', 'automatic', 'session', 'merge')),
  author_id uuid,
  restored_from text,
  source_name text,
  PRIMARY KEY (note_id, unit, version_key),
  CHECK (content_hash IS NOT NULL OR kind = 'removed')
);
CREATE INDEX IF NOT EXISTS note_versions_workspace_idx ON note_versions (workspace_id);
-- the cleanup asks "does any version name this content" (services/maintenance/prune.ts, services/purgedContent.ts deleteUnreferencedBlobs)
CREATE INDEX IF NOT EXISTS note_versions_content_idx ON note_versions (content_hash);

CREATE TABLE IF NOT EXISTS note_version_positions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id uuid NOT NULL,
  unit text NOT NULL,
  version_key text NOT NULL,
  origin text NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (note_id, unit, version_key, origin, seq),
  FOREIGN KEY (note_id, unit, version_key) REFERENCES note_versions (note_id, unit, version_key) ON DELETE CASCADE
);
-- a transaction's own versions (recordVersion's ordinal, the commit check) and, later, a bundle's range per origin
CREATE INDEX IF NOT EXISTS note_version_positions_at_idx ON note_version_positions (workspace_id, origin, seq);
-- one note's versions of one transaction (recordVersion's ordinal, the commit checks, the event map): found by note first, so a transaction
-- that writes thousands of notes looks up each in constant time instead of scanning all its own positions (review of PR #1938 round 1, point 4)
CREATE INDEX IF NOT EXISTS note_version_positions_note_idx ON note_version_positions (note_id, unit, origin, seq);

CREATE TABLE IF NOT EXISTS note_version_events (
  event_id bigint PRIMARY KEY REFERENCES domain_events(id) ON DELETE CASCADE,
  note_id uuid NOT NULL,
  unit text NOT NULL,
  version_key text NOT NULL,
  FOREIGN KEY (note_id, unit, version_key) REFERENCES note_versions (note_id, unit, version_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS note_version_events_version_idx ON note_version_events (note_id, unit, version_key);

-- This node's count of local root writes that changed a note's title or text, or a drawing, and minted no version (the commit check below).
-- Counted, not refused, in batch 1: existing tests write notes with raw SQL inside stamped root writes, and they stay as they are (PR
-- description); every production write path mints, and the tests assert the count stays 0 for them. Next to writes_without_mutate, the same
-- kind of visible exception (sync_clock is node-local); the server log names the note (a WARNING).
ALTER TABLE sync_clock ADD COLUMN IF NOT EXISTS version_misses bigint NOT NULL DEFAULT 0;

-- The one encoding of a field in a key (§4.4 point 9): `<UTF-8 bytes>:<text>`, a missing value `-`.
CREATE OR REPLACE FUNCTION note_version_field(p text) RETURNS text AS $$
  SELECT CASE WHEN p IS NULL THEN '-' ELSE octet_length(p)::text || ':' || p END;
$$ LANGUAGE sql IMMUTABLE;

-- The UTC microsecond text a version's `at` is (IMPORTED_AT).
CREATE OR REPLACE FUNCTION note_version_at(p timestamptz) RETURNS text AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$ LANGUAGE sql IMMUTABLE;

-- g: a version this node recorded as an event (or carried in from a backup), from what it is: note, unit, kind, content, title, time.
CREATE OR REPLACE FUNCTION note_version_legacy_key(p_note uuid, p_unit text, p_kind text, p_hash text, p_title text, p_at text) RETURNS text AS $$
  SELECT 'g:' || encode(sha256(convert_to('onden version 1' || note_version_field(p_note::text) || note_version_field(p_unit) || note_version_field(p_kind)
    || note_version_field(p_hash) || note_version_field(p_title) || note_version_field(p_at), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- b: the content a note or drawing holds that no version names (the root's baseline); not its time (§4.3: a restored copy of the root mints the same key).
CREATE OR REPLACE FUNCTION note_version_baseline_key(p_note uuid, p_unit text, p_hash text) RETURNS text AS $$
  SELECT 'b:' || encode(sha256(convert_to('onden baseline 1' || note_version_field(p_note::text) || note_version_field(p_unit) || note_version_field(p_hash), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Whether the commit check and the minting stand aside in this transaction for `p_ws` (one rule for both: §4.4 points 5, 6, 11).
--   'off'      the shell, a seed or a data migration said so (onden.no_versions);
--   'import'   a snapshot join or a merge is writing what it received (sync_import_active);
--   'bypass'   the transaction's stamp was made by a trigger for a write outside the roots (writes_without_mutate counts it), or there is none;
--   NULL       an ordinary local root write: its versions are checked.
CREATE OR REPLACE FUNCTION note_version_exempt(p_ws uuid) RETURNS text AS $$
DECLARE s jsonb;
BEGIN
  IF COALESCE(current_setting('onden.no_versions', true), '') = 'on' THEN RETURN 'off'; END IF;
  IF sync_import_active(p_ws) THEN RETURN 'import'; END IF;
  s := NULLIF(current_setting(sync_stamp_setting(p_ws), true), '')::jsonb;
  IF s IS NULL OR s ? 'bypass' THEN RETURN 'bypass'; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Notes that have a version list: notes and boards, not tags and not the system's own notes (Site Config). §4.4 point 6.
CREATE OR REPLACE FUNCTION note_version_in_scope(p_node_type text, p_source_type text) RETURNS boolean AS $$
  SELECT p_node_type IN ('content', 'canvas') AND p_source_type IS DISTINCT FROM 'system';
$$ LANGUAGE sql IMMUTABLE;

-- The version an event undo puts back (§4.4 point 4, the rule the backfill below applies to old undos): the last version of the unit that
-- this node's map records for an event before the undone one, when it holds `p_hash`; NULL otherwise. spine/noteVersions.ts versionBeforeEvent.
CREATE OR REPLACE FUNCTION note_version_before_event(p_note uuid, p_unit text, p_undone bigint, p_hash text) RETURNS text AS $$
  SELECT CASE WHEN b.content_hash IS NOT DISTINCT FROM p_hash THEN b.version_key END
    FROM (SELECT ve.version_key, v.content_hash FROM note_version_events ve
            JOIN domain_events pe ON pe.id = ve.event_id
            JOIN note_versions v ON v.note_id = ve.note_id AND v.unit = ve.unit AND v.version_key = ve.version_key
            JOIN domain_events undone ON undone.id = p_undone
           WHERE ve.note_id = p_note AND ve.unit = p_unit AND (pe.created_at, pe.id) < (undone.created_at, undone.id)
           ORDER BY pe.created_at DESC, pe.id DESC LIMIT 1) b;
$$ LANGUAGE sql STABLE;

-- A write that minted no version, counted (see sync_clock.version_misses).
CREATE OR REPLACE FUNCTION note_version_count_miss(p_ws uuid, p_unit text, p_note uuid) RETURNS void AS $$
BEGIN
  UPDATE sync_clock SET version_misses = version_misses + 1 WHERE workspace_id = p_ws;
  RAISE WARNING 'note_version_missing: a write changed % of note % without minting its version (spine/noteVersions.ts recordVersion)', p_unit, p_note;
END;
$$ LANGUAGE plpgsql;

-- At COMMIT (review round 2, point 1): a version this node minted (s:) or a root's baseline (b:) names content that is stored: a body in
-- blobs, a drawing in blobs or this note's ink_manifests. Refused otherwise: the transaction fails as a whole. A received version may come
-- before its content (batches 3-4), so a join or merge stands aside.
CREATE OR REPLACE FUNCTION note_version_check_content() RETURNS trigger AS $$
BEGIN
  IF note_version_exempt(NEW.workspace_id) = 'import' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM blobs b WHERE b.hash = NEW.content_hash)
     OR (NEW.unit <> 'body' AND EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = NEW.note_id AND m.hash = NEW.content_hash)) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'note_version_content_missing: a version names content that is not stored (spine/noteVersions.ts: store it first, then recordVersion)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

-- At COMMIT: the note's title and text as they are now were minted as a version by this transaction, and that text is stored.
-- The text is compared with the stored blob, not hashed again.
CREATE OR REPLACE FUNCTION note_version_check_body() RETURNS trigger AS $$
DECLARE s jsonb; n record;
BEGIN
  IF note_version_exempt(NEW.workspace_id) IS NOT NULL THEN RETURN NULL; END IF;
  SELECT c.title, c.markdown, c.node_type, c.source_type INTO n FROM content_nodes c WHERE c.id = NEW.id;
  IF NOT FOUND OR NOT note_version_in_scope(n.node_type, n.source_type) THEN RETURN NULL; END IF;
  s := current_setting(sync_stamp_setting(NEW.workspace_id), true)::jsonb;
  IF EXISTS (SELECT 1 FROM note_version_positions p
               JOIN note_versions v ON v.note_id = p.note_id AND v.unit = p.unit AND v.version_key = p.version_key
               JOIN blobs b ON b.hash = v.content_hash
              WHERE p.workspace_id = NEW.workspace_id AND p.origin = s->>'origin' AND p.seq = (s->>'seq')::bigint
                AND p.note_id = NEW.id AND p.unit = 'body' AND v.version_key LIKE 's:%'
                AND v.title IS NOT DISTINCT FROM n.title AND b.content = n.markdown) THEN RETURN NULL; END IF;
  PERFORM note_version_count_miss(NEW.workspace_id, 'body', NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- At COMMIT: a drawing this transaction changed has a version minted by it, of that unit, whose content is stored (a removal: a `removed`
-- version). The value itself is not hashed (a drawing is up to 30 MB): the version names the hash its writer computed.
CREATE OR REPLACE FUNCTION note_version_check_ink() RETURNS trigger AS $$
DECLARE s jsonb; r record; n record; gone boolean := TG_OP = 'DELETE';
BEGIN
  IF gone THEN r := OLD; ELSE r := NEW; END IF;
  IF note_version_exempt(r.workspace_id) IS NOT NULL THEN RETURN NULL; END IF;
  SELECT c.node_type, c.source_type INTO n FROM content_nodes c WHERE c.id = r.node_id;
  IF NOT FOUND OR NOT note_version_in_scope(n.node_type, n.source_type) THEN RETURN NULL; END IF;
  -- the drawing as it is at commit: written again later in the transaction, or removed after a write
  gone := NOT EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = r.node_id AND a.key = r.key);
  s := current_setting(sync_stamp_setting(r.workspace_id), true)::jsonb;
  IF EXISTS (SELECT 1 FROM note_version_positions p
               JOIN note_versions v ON v.note_id = p.note_id AND v.unit = p.unit AND v.version_key = p.version_key
              WHERE p.workspace_id = r.workspace_id AND p.origin = s->>'origin' AND p.seq = (s->>'seq')::bigint
                AND p.note_id = r.node_id AND p.unit = r.key AND v.version_key LIKE 's:%'
                AND CASE WHEN gone THEN v.kind = 'removed'
                         ELSE v.kind <> 'removed' AND (EXISTS (SELECT 1 FROM blobs b WHERE b.hash = v.content_hash)
                                                      OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = r.node_id AND m.hash = v.content_hash)) END)
  THEN RETURN NULL; END IF;
  PERFORM note_version_count_miss(r.workspace_id, r.key, r.node_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- At COMMIT: a save event is mapped to the version it recorded (this node's own map, §4.4 point 4). A version of this transaction with the
-- event's content first (in ordinal order: two saves of one note in one transaction map to their own); else, a save that changed nothing,
-- the latest version with that content. A writer that mapped its event itself (spine/importedHistory.ts) is left alone.
CREATE OR REPLACE FUNCTION note_version_link_event() RETURNS trigger AS $$
DECLARE v_unit text; v_hash text; v_note uuid; s jsonb; v_key text;
BEGIN
  IF note_version_exempt(NEW.workspace_id) IN ('off', 'import') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM note_version_events WHERE event_id = NEW.id) THEN RETURN NULL; END IF;
  IF NEW.target_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  v_note := NEW.target_id::uuid;
  IF NEW.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') THEN
    v_unit := NEW.payload->>'key';
    v_hash := CASE WHEN NEW.event_type = 'ATTRIBUTE_DELETED' THEN NULL ELSE NEW.payload->>'value_ref' END;
  ELSE
    v_unit := 'body';
    v_hash := COALESCE(NEW.body_hash, NEW.payload->>'body_hash');
  END IF;
  s := NULLIF(current_setting(sync_stamp_setting(NEW.workspace_id), true), '')::jsonb;
  SELECT v.version_key INTO v_key FROM note_version_positions p
    JOIN note_versions v ON v.note_id = p.note_id AND v.unit = p.unit AND v.version_key = p.version_key
   WHERE s IS NOT NULL AND p.workspace_id = NEW.workspace_id AND p.origin = s->>'origin' AND p.seq = (s->>'seq')::bigint
     AND p.note_id = v_note AND p.unit = v_unit AND v.content_hash IS NOT DISTINCT FROM v_hash AND v.kind <> 'set_aside'
     AND NOT EXISTS (SELECT 1 FROM note_version_events x WHERE x.note_id = v.note_id AND x.unit = v.unit AND x.version_key = v.version_key)
   ORDER BY v.ordinal LIMIT 1;
  IF v_key IS NULL THEN
    SELECT v.version_key INTO v_key FROM note_versions v
     WHERE v.note_id = v_note AND v.unit = v_unit AND v.content_hash IS NOT DISTINCT FROM v_hash AND v.kind <> 'set_aside'
     ORDER BY COALESCE(v.clock_wall, 0) DESC, v.at DESC, v.ordinal DESC LIMIT 1;
  END IF;
  IF v_key IS NOT NULL THEN
    INSERT INTO note_version_events (event_id, note_id, unit, version_key) VALUES (NEW.id, v_note, v_unit, v_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_nodes_have_version_insert ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_have_version_insert AFTER INSERT ON content_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (note_version_in_scope(NEW.node_type, NEW.source_type))
  EXECUTE FUNCTION note_version_check_body();
DROP TRIGGER IF EXISTS content_nodes_have_version_update ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_have_version_update AFTER UPDATE OF title, markdown ON content_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown) AND note_version_in_scope(NEW.node_type, NEW.source_type))
  EXECUTE FUNCTION note_version_check_body();
DROP TRIGGER IF EXISTS node_attributes_ink_have_version_insert ON node_attributes;
CREATE CONSTRAINT TRIGGER node_attributes_ink_have_version_insert AFTER INSERT ON node_attributes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.key IN ('ink_data', 'board_ink', 'note_ink'))
  EXECUTE FUNCTION note_version_check_ink();
-- a write that puts back the value it found (a merge that kept the stored drawing) changes nothing: compared as bytes, never hashed
DROP TRIGGER IF EXISTS node_attributes_ink_have_version_update ON node_attributes;
CREATE CONSTRAINT TRIGGER node_attributes_ink_have_version_update AFTER UPDATE OF value ON node_attributes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.key IN ('ink_data', 'board_ink', 'note_ink') AND OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION note_version_check_ink();
DROP TRIGGER IF EXISTS node_attributes_ink_have_version_delete ON node_attributes;
CREATE CONSTRAINT TRIGGER node_attributes_ink_have_version_delete AFTER DELETE ON node_attributes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.key IN ('ink_data', 'board_ink', 'note_ink'))
  EXECUTE FUNCTION note_version_check_ink();
DROP TRIGGER IF EXISTS note_versions_content_stored ON note_versions;
CREATE CONSTRAINT TRIGGER note_versions_content_stored AFTER INSERT ON note_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.content_hash IS NOT NULL AND (NEW.version_key LIKE 's:%' OR NEW.version_key LIKE 'b:%'))
  EXECUTE FUNCTION note_version_check_content();
DROP TRIGGER IF EXISTS domain_events_link_version ON domain_events;
CREATE CONSTRAINT TRIGGER domain_events_link_version AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((NEW.event_type IN ('NODE_CREATED', 'NODE_UPDATED', 'NODE_RESTORED') AND NEW.payload ? 'body_hash')
     OR (NEW.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') AND NEW.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')))
  EXECUTE FUNCTION note_version_link_event();

-- The old history of one workspace as versions (§8 steps 2-4; step 5, the trash groups, is batch 5's). Returns what it added. Called once per workspace below; safe to call again.
CREATE OR REPLACE FUNCTION note_versions_backfill(p_ws uuid) RETURNS TABLE (versions bigint, baselines bigint, set_aside bigint, s0 bigint) AS $$
DECLARE
  v_node text;
  v_root boolean := NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws);
  v_versions bigint := 0; v_baselines bigint := 0; v_aside bigint := 0; v_s0 bigint := NULL; n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining') THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::bigint, NULL::bigint; RETURN;
  END IF;
  v_node := (SELECT node_id FROM sync_node WHERE singleton);
  IF v_node IS NULL THEN
    INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text) ON CONFLICT (singleton) DO NOTHING;
    v_node := (SELECT node_id FROM sync_node WHERE singleton);
  END IF;

  -- an older drawing save with its value inline: its value is stored first, so it is a stored version like the others
  INSERT INTO blobs (hash, content, size_bytes)
  SELECT DISTINCT encode(sha256(convert_to(e.payload->>'value', 'UTF8')), 'hex'), e.payload->>'value', octet_length(e.payload->>'value')
    FROM domain_events e
   WHERE e.workspace_id = p_ws AND e.event_type = 'ATTRIBUTE_SET' AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')
     AND NOT e.payload ? 'value_ref' AND e.payload ? 'value'
  ON CONFLICT (hash) DO NOTHING;

  CREATE TEMP TABLE IF NOT EXISTS nv_candidates (event_id bigint, created_at timestamptz, note_id uuid, unit text, kind text, hash text, title text,
    keep boolean, stored boolean, author_kind text, author_id uuid, source_name text, restored_event text, event_restored text) ON COMMIT DROP;
  TRUNCATE nv_candidates;
  INSERT INTO nv_candidates
  WITH scoped AS (SELECT c.id FROM content_nodes c WHERE c.workspace_id = p_ws AND note_version_in_scope(c.node_type, c.source_type)),
  ev AS (
    SELECT e.*, n.id AS note_id, a.type AS row_type, a.workspace_id AS row_ws, (e.tx_meta ? 'history_import') AS imported,
           COALESCE(e.tx_meta->'history_import'->>'actor_type', e.actor_type) AS eff_type
      FROM domain_events e JOIN scoped n ON n.id::text = e.target_id
      LEFT JOIN actors a ON a.id::text = e.actor_id
     WHERE e.workspace_id = p_ws
       AND ((e.event_type IN ('NODE_CREATED', 'NODE_UPDATED', 'NODE_RESTORED') AND e.payload ? 'body_hash')
         OR (e.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')))),
  shaped AS (
    SELECT ev.id, ev.created_at, ev.note_id,
           CASE WHEN ev.event_type LIKE 'NODE_%' THEN 'body'
                WHEN ev.payload->>'key' = 'ink_data' AND EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id = ev.note_id AND m.action = 'moved'
                       AND m.restored_at IS NULL AND ev.created_at < m.moved_at) THEN 'board_ink'
                ELSE ev.payload->>'key' END AS unit,
           CASE ev.event_type WHEN 'NODE_CREATED' THEN 'created' WHEN 'NODE_RESTORED' THEN 'restored' WHEN 'NODE_UPDATED' THEN 'updated'
                WHEN 'ATTRIBUTE_DELETED' THEN 'removed'
                ELSE CASE WHEN jsonb_typeof(ev.tx_meta->'prev_field_values') = 'object' THEN 'updated' ELSE 'created' END END AS kind,
           CASE WHEN ev.event_type LIKE 'NODE_%' THEN COALESCE(ev.body_hash, ev.payload->>'body_hash')
                WHEN ev.event_type = 'ATTRIBUTE_DELETED' THEN NULL
                ELSE COALESCE(ev.payload->>'value_ref', encode(sha256(convert_to(ev.payload->>'value', 'UTF8')), 'hex')) END AS hash,
           CASE WHEN ev.event_type LIKE 'NODE_%' THEN ev.payload->>'title' END AS title,
           CASE WHEN NOT ev.imported AND ev.row_type = 'session' THEN 'session' WHEN ev.eff_type = 'ai_agent' THEN 'ai'
                WHEN ev.eff_type = 'system' THEN 'automatic' ELSE 'person' END AS author_kind,
           CASE WHEN NOT ev.imported AND ev.eff_type = 'user' AND ev.row_type = 'human' AND ev.row_ws = p_ws THEN ev.actor_id::uuid END AS author_id,
           CASE WHEN ev.imported THEN ev.tx_meta->'history_import'->>'actor_name' END AS source_name,
           CASE WHEN ev.event_type = 'NODE_RESTORED' THEN ev.payload->>'version_id' END AS restored_event,
           CASE WHEN ev.event_type <> 'NODE_RESTORED' THEN ev.tx_meta->>'restored_from' END AS event_restored
      FROM ev)
  SELECT s.id, s.created_at, s.note_id, s.unit, s.kind, s.hash, s.title,
         CASE WHEN s.unit = 'body'
              THEN s.hash IS DISTINCT FROM lag(s.hash) OVER w OR s.title IS DISTINCT FROM lag(s.title) OVER w
              ELSE s.hash IS DISTINCT FROM lag(s.hash) OVER w OR s.kind = 'removed' OR lag(s.kind) OVER w = 'removed' OR lag(s.kind) OVER w IS NULL END,
         CASE WHEN s.kind = 'removed' THEN true
              WHEN s.unit = 'body' THEN EXISTS (SELECT 1 FROM blobs b WHERE b.hash = s.hash)
              ELSE s.hash IS NOT NULL AND (EXISTS (SELECT 1 FROM blobs b WHERE b.hash = s.hash)
                                           OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = s.note_id AND m.hash = s.hash)) END,
         s.author_kind, s.author_id, s.source_name, s.restored_event, s.event_restored
    FROM shaped s WINDOW w AS (PARTITION BY s.note_id, s.unit ORDER BY s.created_at, s.id);
  ANALYZE nv_candidates;

  -- 2. the saves as `g:` versions: kept and stored ones, ranked by (created_at, id); a key two saves share is one version, the earlier's.
  -- A repeat (not kept) belongs to the kept save before it: every save between the two repeats it, so they hold the same title and content.
  CREATE TEMP TABLE IF NOT EXISTS nv_ranked (event_id bigint, note_id uuid, unit text, kind text, hash text, title text, created_at timestamptz,
    keep boolean, stored boolean, author_kind text, author_id uuid, source_name text, ordinal bigint, grp bigint, key text,
    restored_event text, event_restored text) ON COMMIT DROP;
  TRUNCATE nv_ranked;
  INSERT INTO nv_ranked
  SELECT c.event_id, c.note_id, c.unit, c.kind, c.hash, c.title, c.created_at, c.keep, c.stored, c.author_kind, c.author_id, c.source_name,
         row_number() OVER w, count(*) FILTER (WHERE c.keep) OVER w,
         note_version_legacy_key(c.note_id, c.unit, c.kind, c.hash, c.title, note_version_at(c.created_at)), c.restored_event, c.event_restored
    FROM nv_candidates c WINDOW w AS (PARTITION BY c.note_id, c.unit ORDER BY c.created_at, c.event_id);
  ANALYZE nv_ranked; -- a temporary table has no statistics: without them the joins below are planned for one row
  WITH ins AS (
    INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind, author_id, source_name)
    SELECT DISTINCT ON (r.note_id, r.unit, r.key) p_ws, r.note_id, r.unit, r.key, r.kind, r.title, r.hash, note_version_at(r.created_at), r.ordinal, v_node,
           r.author_kind, r.author_id, r.source_name
      FROM nv_ranked r WHERE r.keep AND r.stored
     ORDER BY r.note_id, r.unit, r.key, r.ordinal
    ON CONFLICT DO NOTHING RETURNING 1)
  SELECT count(*) INTO v_versions FROM ins;

  -- every save event to the version it records: a kept one to its own, a repeat to its group's
  INSERT INTO note_version_events (event_id, note_id, unit, version_key)
  SELECT c.event_id, c.note_id, c.unit, k.key FROM nv_ranked c
    JOIN nv_ranked k ON k.note_id = c.note_id AND k.unit = c.unit AND k.grp = c.grp AND k.keep AND k.stored
  ON CONFLICT DO NOTHING;

  -- 4.4 point 4: "restored from", as the local write path gives it (services/nodeUpdate.ts restoreNodeVersion, eventRestore/restore.ts): only the
  -- save that minted a version decides it (a repeat mints nothing, so it names nothing), the earliest such save when two share a key, never the
  -- version itself; and only from (created_at, id) orders, so every copy of the database gives the same answer whatever the rows' physical order.
  -- A version restore names the restored event (payload.version_id); an event undo names the undone EVENT, so it restored the version before it,
  -- when the content matches.
  UPDATE note_versions v SET restored_from = t.target
    FROM (SELECT DISTINCT ON (r.note_id, r.unit, r.key) r.note_id, r.unit, r.key, m.version_key AS target
            FROM nv_ranked r
            JOIN note_version_events m ON r.restored_event ~ '^\d{1,18}$' AND m.event_id = r.restored_event::bigint AND m.note_id = r.note_id AND m.unit = r.unit
           WHERE r.keep AND r.stored
           ORDER BY r.note_id, r.unit, r.key, r.ordinal) t
   WHERE v.note_id = t.note_id AND v.unit = t.unit AND v.version_key = t.key AND v.restored_from IS NULL AND v.version_key LIKE 'g:%' AND t.target <> t.key;
  UPDATE note_versions v SET restored_from = t.target
    FROM (SELECT DISTINCT ON (r.note_id, r.unit, r.key) r.note_id, r.unit, r.key, before.version_key AS target, before.content_hash AS target_hash
            FROM nv_ranked r
            JOIN domain_events undone ON r.event_restored ~ '^\d{1,18}$' AND undone.id = r.event_restored::bigint
            CROSS JOIN LATERAL (
              SELECT ve.version_key, pv.content_hash FROM note_version_events ve JOIN domain_events pe ON pe.id = ve.event_id
                JOIN note_versions pv ON pv.note_id = ve.note_id AND pv.unit = ve.unit AND pv.version_key = ve.version_key
               WHERE ve.note_id = r.note_id AND ve.unit = r.unit AND (pe.created_at, pe.id) < (undone.created_at, undone.id)
               ORDER BY pe.created_at DESC, pe.id DESC LIMIT 1) before
           WHERE r.keep AND r.stored
           ORDER BY r.note_id, r.unit, r.key, r.ordinal) t
   WHERE v.note_id = t.note_id AND v.unit = t.unit AND v.version_key = t.key AND v.restored_from IS NULL AND v.version_key LIKE 'g:%'
     AND t.target_hash IS NOT DISTINCT FROM v.content_hash AND t.target <> t.key;

  -- a drawing a conflict overrode that no version holds (see the header)
  WITH aside AS (
    SELECT DISTINCT ON (n.id, unit.u, e.payload->>'overridden_value_ref') e.id, e.created_at, n.id AS note_id, unit.u AS unit, e.payload->>'overridden_value_ref' AS hash
      FROM domain_events e JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = p_ws AND note_version_in_scope(n.node_type, n.source_type)
      CROSS JOIN LATERAL (SELECT CASE WHEN e.payload->>'key' = 'ink_data' AND EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id = n.id AND m.action = 'moved'
                                  AND m.restored_at IS NULL AND e.created_at < m.moved_at) THEN 'board_ink' ELSE e.payload->>'key' END AS u) unit
     WHERE e.workspace_id = p_ws AND e.event_type = 'ATTRIBUTE_CONFLICT' AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')
       AND e.payload ? 'overridden_value_ref'
       AND (EXISTS (SELECT 1 FROM blobs b WHERE b.hash = e.payload->>'overridden_value_ref')
            OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = n.id AND m.hash = e.payload->>'overridden_value_ref'))
       AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND v.unit = unit.u AND v.content_hash = e.payload->>'overridden_value_ref')
     ORDER BY n.id, unit.u, e.payload->>'overridden_value_ref', e.created_at, e.id),
  ins AS (
    INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, ordinal, recorded_by, author_kind)
    SELECT p_ws, a.note_id, a.unit, note_version_legacy_key(a.note_id, a.unit, 'set_aside', a.hash, NULL, note_version_at(a.created_at)), 'set_aside', a.hash,
           note_version_at(a.created_at), 0, v_node, 'person'
      FROM aside a ON CONFLICT DO NOTHING RETURNING 1)
  SELECT count(*) INTO v_aside FROM ins;

  -- 4. the root's baselines: content that no version names, not empty. Its text is stored in the same step (no write runs meanwhile).
  IF v_root THEN
    INSERT INTO blobs (hash, content, size_bytes)
    SELECT encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex'), c.markdown, octet_length(c.markdown)
      FROM content_nodes c WHERE c.workspace_id = p_ws AND note_version_in_scope(c.node_type, c.source_type) AND c.markdown <> ''
       AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = c.id AND v.unit = 'body' AND v.content_hash = encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex'))
    ON CONFLICT (hash) DO NOTHING;
    WITH ins AS (
      INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind)
      SELECT p_ws, c.id, 'body', note_version_baseline_key(c.id, 'body', h.hash), 'baseline', c.title, h.hash, note_version_at(c.updated_at), 0, v_node, 'automatic'
        FROM content_nodes c CROSS JOIN LATERAL (SELECT encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex') AS hash) h
       WHERE c.workspace_id = p_ws AND note_version_in_scope(c.node_type, c.source_type) AND c.markdown <> ''
         AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = c.id AND v.unit = 'body' AND v.content_hash = h.hash)
      ON CONFLICT DO NOTHING RETURNING 1)
    SELECT count(*) INTO n FROM ins;
    v_baselines := n;
    -- the one-time hashing of each drawing that has no version (a drawing saved before 172 without an event, for example)
    CREATE TEMP TABLE IF NOT EXISTS nv_ink_base (node_id uuid, key text, hash text, updated_at timestamptz) ON COMMIT DROP;
    TRUNCATE nv_ink_base;
    INSERT INTO nv_ink_base
    SELECT a.node_id, a.key, encode(sha256(convert_to(a.value, 'UTF8')), 'hex'), a.updated_at
      FROM node_attributes a JOIN content_nodes c ON c.id = a.node_id AND note_version_in_scope(c.node_type, c.source_type)
     WHERE a.workspace_id = p_ws AND a.key IN ('ink_data', 'board_ink', 'note_ink') AND a.value <> '';
    DELETE FROM nv_ink_base i WHERE EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = i.node_id AND v.unit = i.key AND v.content_hash = i.hash);
    INSERT INTO blobs (hash, content, size_bytes)
    SELECT i.hash, a.value, octet_length(a.value) FROM nv_ink_base i JOIN node_attributes a ON a.node_id = i.node_id AND a.key = i.key
     WHERE NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = i.node_id AND m.hash = i.hash)
    ON CONFLICT (hash) DO NOTHING;
    WITH ins AS (
      INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, ordinal, recorded_by, author_kind)
      SELECT p_ws, i.node_id, i.key, note_version_baseline_key(i.node_id, i.key, i.hash), 'baseline', i.hash, note_version_at(i.updated_at), 0, v_node, 'automatic'
        FROM nv_ink_base i ON CONFLICT DO NOTHING RETURNING 1)
    SELECT count(*) INTO n FROM ins;
    v_baselines := v_baselines + n;
  END IF;

  -- 3. one real sequence number for what this pass wrote, only when it wrote something that has no position yet (a second run takes none)
  IF EXISTS (SELECT 1 FROM note_versions v WHERE v.workspace_id = p_ws AND v.version_key NOT LIKE 's:%'
               AND NOT EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key)) THEN
    SELECT c.next_seq INTO v_s0 FROM sync_lock_clock(p_ws) c;
    UPDATE sync_clock SET next_seq = v_s0 + 1 WHERE workspace_id = p_ws;
    INSERT INTO note_version_positions (workspace_id, note_id, unit, version_key, origin, seq)
    SELECT p_ws, v.note_id, v.unit, v.version_key, v_node, v_s0 FROM note_versions v
     WHERE v.workspace_id = p_ws AND v.version_key NOT LIKE 's:%'
       AND NOT EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key);
  END IF;
  RETURN QUERY SELECT v_versions, v_baselines, v_aside, v_s0;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE w record;
BEGIN
  FOR w IN SELECT id FROM workspaces ORDER BY id LOOP
    PERFORM note_versions_backfill(w.id);
  END LOOP;
END $$;

-- 221: the merge core before the transport, batch 1 (db/migrations/221_merge_core_before_transport.sql)
CREATE OR REPLACE FUNCTION sync_allocate_stamp(p_ws uuid) RETURNS jsonb AS $$
DECLARE
  c record;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  new_wall bigint;
  new_counter integer;
BEGIN
  SELECT * INTO c FROM sync_lock_clock(p_ws);
  IF now_ms > c.hlc_wall THEN new_wall := now_ms; new_counter := 0;
  ELSE new_wall := c.hlc_wall; new_counter := c.hlc_counter + 1; END IF;
  UPDATE sync_clock SET next_seq = c.next_seq + 1, hlc_wall = new_wall, hlc_counter = new_counter,
                        writes_without_mutate = writes_without_mutate + 1 WHERE workspace_id = p_ws;
  -- `system`: nobody who looked at a unit's heads wrote this (migration 206 sync_stamp_put_over refuses it on a unit in conflict)
  RETURN jsonb_build_object('origin', c.node_id, 'seq', c.next_seq, 'wall', new_wall, 'counter', new_counter, 'bypass', true, 'system', true);
END;
$$ LANGUAGE plpgsql;
-- 222: a snapshot names the other origins its source holds, per label; the join remembers them (db/migrations/222_sync_join_source_brought.sql)
ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS source_brought jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 224: a database restored WITHOUT a new node id says so (db/migrations/224_sync_restore_kept_node_id.sql)
CREATE TABLE IF NOT EXISTS sync_restore_kept_node_id (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kept_at timestamptz NOT NULL DEFAULT now(),
  node_id text,
  overwritten text,
  reason text NOT NULL
);

-- 226: the two statement triggers of 215 find a row's stamps through the primary key, not by reading the whole table (db/migrations/226_stamp_triggers_use_the_key.sql)
CREATE OR REPLACE FUNCTION sync_rows_made_afresh() RETURNS trigger AS $$
DECLARE v_table text := TG_TABLE_NAME; v_keys text[]; v_ws uuid[];
BEGIN
  IF TG_TABLE_NAME = 'block_anchors' THEN SELECT array_agg(n.anchor_id), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN SELECT array_agg(n.id::text), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  ELSE SELECT array_agg(n.note_id::text), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  END IF;
  IF v_keys IS NULL THEN RETURN NULL; END IF;
  -- the new creation says which of the key's old field writes it was made over (`meta.seen`, what a creation over a delete says: store.ts droppedBySeen), so every
  -- node drops the same ones, not only this one (review of PR #1853, round 9, point 5 c: the other node kept them as heads beside the new values)
  -- merged, origin by origin, with what the creation already said it was made over (a delete's `seen` it carries: migration 206), never in place of it
  UPDATE sync_stamps s SET meta = COALESCE(s.meta, '{}'::jsonb) || jsonb_build_object('seen', (
           SELECT jsonb_object_agg(z.origin, z.m) FROM (SELECT y.origin, max(y.seq) AS m FROM (
             SELECT e.key AS origin, e.value::bigint AS seq FROM jsonb_each_text(COALESCE(s.meta -> 'seen', '{}'::jsonb)) e
             UNION ALL SELECT e.key, e.value::bigint FROM jsonb_each_text(o.seen) e) y GROUP BY y.origin) z))
    FROM (SELECT u.w, u.k, jsonb_object_agg(u.origin, u.m) AS seen FROM (
            -- each key's own stamps and heads, looked up by the key (LATERAL): a join on (workspace_id, row_key) with the UNION ALL built first read every
            -- stamp of the label and hashed it (migration 226)
            SELECT x.w, x.k, t.origin, max(t.seq) AS m FROM unnest(v_ws, v_keys) AS x(w, k)
              CROSS JOIN LATERAL (SELECT origin, seq FROM sync_stamps WHERE workspace_id = x.w AND table_name = v_table AND row_key = x.k AND field <> '*' AND origin <> 'genesis'
                    UNION ALL SELECT origin, seq FROM sync_stamp_heads WHERE workspace_id = x.w AND table_name = v_table AND row_key = x.k AND field <> '*' AND origin <> 'genesis') t
             GROUP BY x.w, x.k, t.origin) u GROUP BY u.w, u.k) o
   WHERE s.workspace_id = o.w AND s.table_name = v_table AND s.row_key = o.k AND s.field = '*' AND NOT s.deleted;
  DELETE FROM sync_stamps s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = v_table AND s.row_key = x.k AND s.field <> '*';
  DELETE FROM sync_stamp_heads s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = v_table AND s.row_key = x.k AND s.field <> '*';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION sync_rows_go_with_note() RETURNS trigger AS $$
DECLARE v_table text := TG_TABLE_NAME; r record; v_keys text[]; v_notes uuid[]; v_ws uuid[]; v_gone text[]; v_ws1 uuid; v_cols jsonb;
BEGIN
  -- the units' columns, as the stamp trigger names them ('note=note_id,anchor=anchor_id,…')
  SELECT jsonb_object_agg(split_part(p, '=', 1), split_part(p, '=', 2)) INTO v_cols FROM unnest(string_to_array(TG_ARGV[0], ',')) AS p;
  IF TG_TABLE_NAME = 'block_anchors' THEN SELECT array_agg(o.anchor_id), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN SELECT array_agg(o.id::text), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  ELSE SELECT array_agg(o.note_id::text), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  END IF;
  IF v_keys IS NULL THEN RETURN NULL; END IF;
  -- deleted while the note is here: a tombstone each (a save retires a few anchors; a merge applies a received tombstone)
  FOR r IN SELECT n.workspace_id AS w, x.k FROM unnest(v_keys, v_notes) AS x(k, n) JOIN content_nodes n ON n.id = x.n LOOP
    PERFORM sync_stamp_row_deleted(r.w, TG_TABLE_NAME, r.k);
  END LOOP;
  -- gone with their note: those made in it leave nothing; those moved into it keep their stamps (above)
  FOR v_ws1 IN SELECT DISTINCT w FROM unnest(v_ws) AS w LOOP
    SELECT array_agg(x.k) INTO v_gone FROM unnest(v_keys, v_notes, v_ws) AS x(k, n, w)
     WHERE x.w = v_ws1 AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = x.n)
       AND NOT EXISTS (SELECT 1 FROM sync_stamps s WHERE s.workspace_id = v_ws1 AND s.table_name = v_table AND s.row_key = x.k AND s.field = 'note');
    IF v_gone IS NOT NULL THEN
      DELETE FROM sync_stamps s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = v_table AND s.row_key = g.k;
      DELETE FROM sync_stamp_heads s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = v_table AND s.row_key = g.k;
    END IF;
  END LOOP;
  -- those moved into it keep each stamp's value: the row was the one place that held the winners' (a transition table's row is an anonymous record: made the table's
  -- row type again for sync_logged_value)
  IF TG_TABLE_NAME = 'block_anchors' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_anchors, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = v_table AND s.row_key = o.anchor_id AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_nodes, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = v_table AND s.row_key = o.id::text AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  END IF; -- an anchors unit is keyed by its note: it never moves into another, so nothing of it is kept
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
