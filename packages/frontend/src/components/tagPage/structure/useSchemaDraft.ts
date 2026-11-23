import { useCallback, useEffect, useRef, useState } from "react";
import { createSaveDebounce, SAVE_DEBOUNCE_MS } from "../../../lib/persistScheduler";
import { onPageHide } from "../../../lib/pageHide";
import type { Tag } from "../../../lib/api";
import { namedFields, tagSchemaWriter } from "../../../lib/data";
import type { TagModuleBehaviour } from "../../../lib/tagModules";
import type { Behaviour, FieldDef } from "../../TagsPanel";

type SchemaPatch = Partial<{ fields: FieldDef[]; behaviour: Behaviour }>;

/** The tag's editable schema (fields, behaviour) and its saving status.
 *
 *  `save(patch)` shows the edit at once and submits it after a 600ms pause;
 *  edits across sections within one window MERGE into one PATCH. `flush()`
 *  submits what is waiting now (also when the page unmounts). `status` is
 *  "queued" when the schema writer holds the edit for later (offline or a
 *  transient failure) and "error" when it was refused. `tag` is the live
 *  catalog row; the draft follows it while it has no edits of its own. */
export function useSchemaDraft({ tag, onSaved }: { tag: Tag; onSaved?: () => void }) {
  const [fields, setFields] = useState<FieldDef[]>(tag.schema_fields ?? []);
  // The catalog row (data.tags, also kept offline) already carries the fields and
  // behaviour from /api/tags; start from it so the page is whole offline.
  const [behaviour, setBehaviour] = useState<(Behaviour & TagModuleBehaviour) | null>((tag.schema_behaviour as (Behaviour & TagModuleBehaviour) | null | undefined) ?? null);
  const [status, setStatus] = useState<"saved" | "saving" | "queued" | "error">("saved");
  const statusRef = useRef(status);
  statusRef.current = status;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const behaviourRef = useRef(behaviour);
  behaviourRef.current = behaviour;
  const debounce = useRef(createSaveDebounce(SAVE_DEBOUNCE_MS.schema)).current;
  // Edits across sections within one debounce window MERGE into one PATCH —
  // a single timer with per-call payloads would drop the earlier section's
  // change (UI shows it, reload loses it).
  const pending = useRef<SchemaPatch>({});

  // The catalog row (data.tags: kept current by sync, also offline) is the one source of the saved
  // settings, and tagSchemaWriter writes every save into it at once. So a change that is not ours
  // (another device, a reconnect) arrives as a different row, and is shown unless this editor still has
  // edits of its own: typed and waiting, in flight, queued, or refused and kept for the person to fix.
  // There is no read of its own that a late, older answer could win.
  const stored = tag.schema_fields;
  const storedBehaviour = tag.schema_behaviour;
  useEffect(() => {
    if (Object.keys(pending.current).length || statusRef.current !== "saved") return;
    if (JSON.stringify(namedFields(fieldsRef.current)) === JSON.stringify(stored ?? [])) return;
    setFields((stored ?? []) as FieldDef[]);
  }, [stored]);
  useEffect(() => {
    if (Object.keys(pending.current).length || statusRef.current !== "saved") return;
    if (JSON.stringify(behaviourRef.current ?? {}) === JSON.stringify(storedBehaviour ?? {})) return;
    setBehaviour((storedBehaviour ?? {}) as Behaviour & TagModuleBehaviour);
  }, [storedBehaviour]);

  // One debounced PATCH carrying every slice edited in the window (600ms).
  const flush = useCallback(async () => {
      debounce.cancel();
      const body = pending.current;
      if (Object.keys(body).length === 0) return;
      pending.current = {};
      try {
        // The tag-schema writer queues it offline / on a transient failure and
        // replays it; a refusal is reported once (a toast, not only the status
        // label — GAP-144). Editing a tag's schema is a queued CONFIG
        // edit — the server applies it when the write drains.
        const res = await tagSchemaWriter.update(tag.id, body);
        setStatus(res.status === "queued" ? "queued" : "saved");
        if (res.status === "synced") onSaved?.(); // refresh only when actually applied
      } catch { setStatus("error"); }
  }, [tag.id, onSaved, debounce]);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    // Hiding the page submits the draft too: a closed tab would drop the timer.
    const stop = onPageHide(() => { void flushRef.current(); });
    return () => {
      stop();
      // Leaving a tag must submit its captured draft, not abandon the timer or
      // merge it with the next tag's settings. The shared queue owns retries.
      void flushRef.current();
    };
  }, []);
  const save = useCallback((patch: SchemaPatch) => {
    pending.current = { ...pending.current, ...patch };
    setStatus("saving");
    debounce.run(() => void flush());
  }, [flush, debounce]);

  return { fields, setFields, behaviour, setBehaviour, status, save, flush };
}
