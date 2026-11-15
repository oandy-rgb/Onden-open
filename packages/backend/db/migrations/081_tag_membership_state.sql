-- A per-pair identity for conflict-safe tag undo, including absent relations.
-- Unlike membership_epoch this is NOT a clock: a verified inverse restores its
-- predecessor identity, allowing a sequence of related operations to unwind.
-- Ordinary SQL changes always mint a fresh identity, even without an event.
CREATE TABLE public.node_tag_states (
    node_id uuid NOT NULL REFERENCES public.content_nodes(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES public.content_nodes(id) ON DELETE CASCADE,
    is_applied boolean NOT NULL,
    state_id uuid,
    previous_state_id uuid,
    PRIMARY KEY (node_id, tag_id),
    CHECK (NOT is_applied OR state_id IS NOT NULL)
);

CREATE INDEX node_tag_states_tag_idx ON public.node_tag_states (tag_id);

CREATE FUNCTION public.track_node_tag_state() RETURNS trigger
LANGUAGE plpgsql AS $$
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

-- Creating the trigger locks out concurrent membership writers until this
-- migration commits; the subsequent seed therefore cannot miss an application.
CREATE TRIGGER node_tags_state_tracking AFTER INSERT OR DELETE OR UPDATE ON public.node_tags
FOR EACH ROW EXECUTE FUNCTION public.track_node_tag_state();

-- Existing membership gets an identity, but old events are deliberately NOT
-- backfilled: their relationship to the current state cannot be proven.
INSERT INTO public.node_tag_states (node_id, tag_id, is_applied, state_id)
SELECT node_id, tag_id, true, gen_random_uuid() FROM public.node_tags;
