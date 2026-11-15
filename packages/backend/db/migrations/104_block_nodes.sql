-- Block nodes (docs/architecture/block-nodes.md, B1): a block of a note
-- upgraded to a node by `{tags}` at its end — a child of the note (or of the
-- enclosing block node) with its own tags. Its text stays in the note; the
-- note's `^id` is its identity. Kept in their own tables, not content_nodes,
-- so nothing that reads notes (tree, search, backup, embeddings, the
-- published site) sees them unless it asks.

CREATE TABLE block_nodes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    note_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
    -- The `^id` in the note's text.
    block_ref text NOT NULL,
    -- The enclosing block node; NULL = the note itself. Recomputed on save.
    parent_block_id uuid REFERENCES block_nodes(id) ON DELETE SET NULL,
    kind text NOT NULL,
    -- What the block reads as (a heading's text, else its first words).
    label text DEFAULT ''::text NOT NULL,
    -- The block's text as of the last save: an index for "include blocks"
    -- results only, never the source (that is the note) and never indexed
    -- elsewhere (search, embeddings, backup, the published site).
    text_cache text DEFAULT ''::text NOT NULL,
    -- `{…}` removed while the `^id` stays: not a block node now, but its data
    -- is kept for when the tags come back (doc: 已決定 1).
    hidden_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT block_nodes_ref_chk CHECK (((block_ref ~ '^[a-zA-Z0-9-]+$'::text) AND (length(block_ref) <= 64))),
    CONSTRAINT block_nodes_kind_chk CHECK ((kind = ANY (ARRAY['paragraph'::text, 'listItem'::text, 'heading'::text, 'quote'::text]))),
    CONSTRAINT block_nodes_note_ref_uq UNIQUE (note_id, block_ref)
);
CREATE INDEX block_nodes_workspace_idx ON block_nodes (workspace_id);
CREATE INDEX block_nodes_parent_idx ON block_nodes (parent_block_id) WHERE (parent_block_id IS NOT NULL);

-- A block node's own tags (class_tag rows), as written in its `{…}`.
CREATE TABLE block_node_tags (
    block_node_id uuid NOT NULL REFERENCES block_nodes(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    PRIMARY KEY (block_node_id, tag_id)
);
CREATE INDEX block_node_tags_tag_idx ON block_node_tags (tag_id);

-- 「不往下繼承」(Org-mode's org-tags-exclude-from-inheritance): whether a tag
-- reaches the block nodes below the one it is on. NULL = by kind: a reserved
-- / module tag (review, task: a parent card is no reason for a child card)
-- does not, any other tag does. Same idea as node_attributes.is_inheritable.
-- A column, not tag_schema: a schema makes a tag a collection.
ALTER TABLE content_nodes ADD COLUMN tag_is_inheritable boolean;
COMMENT ON COLUMN content_nodes.tag_is_inheritable IS 'class_tag only: does the tag reach the block nodes below the one it is on (block-nodes.md)? NULL = default by kind (reserved/module tags no, others yes).';
