-- 203: a big drawing is stored as chunks (docs/agents/decisions-canvas.md, 手寫存檔量).
--
-- A PDF note's ink_data is one value of several MB that every stroke saves again, and every save kept a full copy of it in
-- `blobs` for good (history, undo and "restore this version" read those copies). A value over INK_CHUNK_THRESHOLD is now cut at
-- object boundaries into chunks (services/inkChunks.ts): each chunk is a row of `ink_chunks` of this note, content-addressed
-- within it (the part of the drawing a stroke did not touch is stored once, however many saves it is part of), and
-- `ink_manifests` lists, in order, the chunks that make one saved value up. The value keeps its own hash (sha256 of the whole
-- text), so events, history and restore still name it by the same `value_ref`; only reading it back (services/inkChunks.ts
-- readInkValues) knows about chunks. Both tables belong to one note and go with it when it is purged (ON DELETE CASCADE).
--
-- Additive only: nothing existing is changed, deleted or rewritten. A value stored whole before this stays a `blobs` row and is
-- read as before; both forms are read.
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
  -- sha256 hex of the whole value: what an event's value_ref names.
  hash text NOT NULL,
  -- The chunk hashes in order, raw 32-byte SHA-256 digests back to back (hex text would be twice the size, and a manifest
  -- is written for every save of the drawing).
  chunks bytea NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, hash)
);
CREATE INDEX IF NOT EXISTS ink_manifests_workspace_idx ON ink_manifests (workspace_id);
