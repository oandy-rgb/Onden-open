-- 140: a system job (spine/systemJobs.ts) has no personal space. A note created
-- by one without a parent and without a space used to fall through to the
-- default shared space; now the create is refused. People and agents are
-- unchanged. mutate() sets onden.system_actor for the transaction.

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
