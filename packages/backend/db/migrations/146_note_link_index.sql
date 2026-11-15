-- 146: which link targets each note's text names, so renaming or creating a
-- note finds the notes that link to its name by an index lookup instead of
-- reading every note's text (services/wikilinkEdges.ts relinkTarget).
--
-- link_lc / link_slug are the arrays syncWikilinkEdges matches with
-- (linkMatchesNodeSql): each `[[target]]` of the text as extractWikilinks
-- reads it, lowercased, and its slugify. They describe the note's text only
-- while `stale` is false. Every note has a row: a new note starts stale, and
-- any change to `markdown` makes its row stale again (triggers below, so a
-- writer that forgets the index cannot leave a wrong one); syncWikilinkEdges
-- fills the arrays and clears `stale`. relinkTarget reads the text of stale
-- notes, as it did before this table. Existing notes start stale; the server
-- indexes them at start-up (services/wikilinkEdges.ts indexMissingNoteLinks).
CREATE TABLE note_link_index (
    note_id uuid PRIMARY KEY REFERENCES content_nodes(id) ON UPDATE CASCADE ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    link_lc text[] NOT NULL DEFAULT '{}',
    link_slug text[] NOT NULL DEFAULT '{}',
    stale boolean NOT NULL DEFAULT true
);
CREATE INDEX note_link_index_lc_idx ON note_link_index USING gin (link_lc);
CREATE INDEX note_link_index_slug_idx ON note_link_index USING gin (link_slug);
CREATE INDEX note_link_index_stale_idx ON note_link_index (workspace_id) WHERE stale;

CREATE FUNCTION note_link_index_new_note() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO note_link_index (note_id, workspace_id) VALUES (NEW.id, NEW.workspace_id)
  ON CONFLICT (note_id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE FUNCTION note_link_index_text_changed() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
  UPDATE note_link_index SET stale = true WHERE note_id = NEW.id AND NOT stale;
  RETURN NULL;
END;
$$;

CREATE TRIGGER content_nodes_note_link_index_insert
    AFTER INSERT ON content_nodes
    FOR EACH ROW EXECUTE FUNCTION note_link_index_new_note();
CREATE TRIGGER content_nodes_note_link_index_text
    AFTER UPDATE OF markdown ON content_nodes
    FOR EACH ROW WHEN (OLD.markdown IS DISTINCT FROM NEW.markdown)
    EXECUTE FUNCTION note_link_index_text_changed();

INSERT INTO note_link_index (note_id, workspace_id)
SELECT id, workspace_id FROM content_nodes
ON CONFLICT (note_id) DO NOTHING;
