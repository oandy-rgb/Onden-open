-- 149_ai_suggestions.sql (tables: ai_edit_suggestions, ai_edit_suggestion_items. The name ai_suggestions is taken by an old, unused table of the removed API AI.)
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
