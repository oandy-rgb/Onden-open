-- 143: which `^id` each note anchors, for ALL blocks (not just the ones
-- upgraded to block nodes by `{tags}`).
--
-- `[[A#^id]]` falls back to the same `^id` elsewhere in the workspace when A
-- no longer has it (a paragraph moved to a child note, pasted into another
-- note, imported from outside). block_nodes only holds tagged blocks, so
-- finding an untagged id would mean scanning every body; this index answers
-- "which notes anchor ^id" with one lookup. It is only an index: the note's
-- text stays the source, and the lookup re-reads the few candidate bodies
-- before using one (services/blockRefLookup.ts). Kept in step with the text
-- by every body write (services/noteBlockRefs.ts); rows go with the note.
CREATE TABLE note_block_refs (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    note_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
    block_ref text NOT NULL,
    PRIMARY KEY (note_id, block_ref),
    CONSTRAINT note_block_refs_ref_chk CHECK (block_ref ~ '^[a-zA-Z0-9-]+$' AND length(block_ref) <= 64)
);
CREATE INDEX note_block_refs_lookup_idx ON note_block_refs (workspace_id, block_ref);

-- Existing notes: every `^id` that ends a line. Looser than the parser (a
-- code fence's `^id` is included); the lookup checks the candidate's text
-- with the real parser, so an extra row costs one read and never a wrong link.
INSERT INTO note_block_refs (workspace_id, note_id, block_ref)
SELECT DISTINCT n.workspace_id, n.id, m[1]
  FROM content_nodes n
  CROSS JOIN LATERAL regexp_matches(n.markdown, '(?:^|[ \t])\^([a-zA-Z0-9-]{1,64})[ \t]*$', 'gn') AS m
 WHERE n.deleted_at IS NULL AND n.markdown LIKE '%^%'
ON CONFLICT DO NOTHING;
