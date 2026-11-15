import { useCallback, useEffect, useRef, useState } from "react";
import { createSaveDebounce, SAVE_DEBOUNCE_MS } from "../../../lib/persistScheduler";
import { onPageHide } from "../../../lib/pageHide";
import type { Tag } from "../../../lib/api";
import { reads, tagSchemaWriter } from "../../../lib/data";
import type { TagModuleBehaviour } from "../../../lib/tagModules";
import type { Behaviour, FieldDef } from "../../TagsPanel";

type FullTagRow = {
  id: string;
  schema_fields: FieldDef[] | null;
  schema_behaviour: (Behaviour & TagModuleBehaviour) | null;
};

type SchemaPatch = Partial<{ fields: FieldDef[]; behaviour: Behaviour }>;

/** The tag's editable schema (fields, behaviour) and its saving status.
 *
 *  `save(patch)` shows the edit at once and submits it after a 600ms pause;
 *  edits across sections within one window MERGE into one PATCH. `flush()`
 *  submits what is waiting now (also when the page unmounts). `status` is
 *  "queued" when the schema writer holds the edit for later (offline or a
 *  transient failure) and "error" when it was refused. When the page is
 *  online the full current settings are read once from the server; a failed
 *  read calls `onLoadError`. */
export function useSchemaDraft({ tag, online, onSaved, onLoadError }: {
  tag: Tag; online: boolean; onSaved?: () => void; onLoadError: () => void;
}) {
  const [fields, setFields] = useState<FieldDef[]>(tag.schema_fields ?? []);
  // The catalog row (data.tags, also kept offline) already carries the fields and
  // behaviour from /api/tags; start from it so the page is whole offline.
  const [behaviour, setBehaviour] = useState<(Behaviour & TagModuleBehaviour) | null>((tag.schema_behaviour as (Behaviour & TagModuleBehaviour) | null | undefined) ?? null);
  const [status, setStatus] = useState<"saved" | "saving" | "queued" | "error">("saved");
  const statusRef = useRef(status);
  statusRef.current = status;
  const debounce = useRef(createSaveDebounce(SAVE_DEBOUNCE_MS.schema)).current;
  // Edits across sections within one debounce window MERGE into one PATCH —
  // a single timer with per-call payloads would drop the earlier section's
  // change (UI shows it, reload loses it).
  const pending = useRef<SchemaPatch>({});

  // Confirm the editing settings from the server whenever this page is online
  // (on open, and again after reconnecting); offline the catalog copy stands.
  useEffect(() => {
    if (!online) return;
    let live = true;
    reads.tags.all<FullTagRow>()
      .then((rows) => {
        // Edits not yet on the server (typed, or queued offline) are newer than this read.
        if (!live || Object.keys(pending.current).length || statusRef.current !== "saved") return;
        const row = rows.find((r) => r.id === tag.id);
        setFields((row?.schema_fields ?? []) as FieldDef[]);
        setBehaviour(row?.schema_behaviour ?? {});
      })
      .catch(() => { if (live) onLoadError(); });
    return () => { live = false; };
  }, [tag.id, online]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed tag page owns this snapshot

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
