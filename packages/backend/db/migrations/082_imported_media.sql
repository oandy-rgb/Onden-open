-- Internal immutable-file index, not node state or permission ownership.
-- The digest stays private; clients receive the existing random media URL.
-- Actor partitioning prevents one uploader from discovering another's assets
-- by submitting known bytes. Reuse also checks current media read policy.
CREATE TABLE imported_media (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  extension text NOT NULL CHECK (extension IN ('.png','.jpg','.jpeg','.gif','.webp','.svg','.avif')),
  filename text NOT NULL UNIQUE CHECK (filename ~ '^[0-9a-f]{32}\.[a-z]+$'),
  PRIMARY KEY (workspace_id, actor_id, content_hash, extension)
);
