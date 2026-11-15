-- 173: distributed sync (beta), step 1. The engine's own tables; nothing existing changes.
--
-- A node (a device or a server) keeps the ops it made and the ops it received in ds_ops. State is derived from them
-- (services/distributedSync/materialize.ts) and is not stored here. The module is off by default (ONDEN_DISTRIBUTED_SYNC);
-- until it is switched on these tables stay empty and no code path reads or writes them.
-- Design: docs/architecture/distributed-sync.md.
--
--   ds_node        one row: who this node is, its clock and the next sequence number for its own ops.
--   ds_ops         every op this node knows: made here or received. Append-only (triggers refuse UPDATE and DELETE),
--                  so history cannot lose an op. `space_id` is the permission scope and what decides who is sent it.
--   ds_rejections  what was refused on arrival and why (forged author, unreadable space, clock too far ahead, the same op id
--                  with different content). Diagnostics and history, never replayed or forwarded.
--   ds_peers       which actors each other node may speak for, set when two nodes pair.

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
