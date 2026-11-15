import { useState } from "react";
import { readSession, writeSession } from "../lib/sessionPrefs";
import { useLiveEventLog } from "./useLiveEventLog";
import { accountStorageKey } from "../lib/accountStorage";
import type { InkMergeConflict } from "@onden/markdown/ink";

// Recent attribute conflicts (two writers set the same field; the later one
// won) and body conflicts (two writers changed the same lines; the later
// one's text was kept, lib/bodyConflict.ts), for the inbox. Live, so a
// conflict shows within seconds. Dismissing one hides it for this tab
// session: a transient alert, not a record. The dismissals are kept per
// account, so a shared browser does not hide one person's conflicts from
// another.

/** The payload of an ATTRIBUTE_CONFLICT event (backend
 *  services/attributeWrites.ts conflictRecord). A drawing's two values are
 *  not in it — the server keeps them as blob references and the event list
 *  leaves them out — only `ink_conflicts`, the items both sides changed
 *  (absent on drawings recorded before D88). Older records lack the types. */
export type ConflictPayload = {
  key: string;
  incoming_value?: string;
  overridden_value?: string;
  value_type?: string;
  overridden_value_type?: string;
  ink_conflicts?: InkMergeConflict[];
  /** Text boxes on a page (`page_text`): the boxes both sides changed. */
  page_text_conflicts?: Array<{ pageKey: string; id: string }>;
  /** Pictures on a page (`page_images`): the ones both sides changed. */
  page_images_conflicts?: Array<{ pageKey: string; id: string }>;
  server_updated_at: string;
  client_updated_at: string;
  actor_id?: string | null;
};

const STORE = "onden:dismissed_conflicts";

function storageKey(): string | null {
  try { return accountStorageKey(STORE); } catch { return null; }
}

// Event ids are unique across types, so both lists share one dismissal set
// (each write re-reads it, so one list's dismissals keep the other's).
function readDismissed(): Set<number> {
  const key = storageKey();
  if (!key) return new Set();
  try {
    const raw = readSession(key);
    return raw ? new Set(JSON.parse(raw) as number[]) : new Set();
  } catch { return new Set(); }
}

export function useAttributeConflicts() {
  return useConflictEvents("ATTRIBUTE_CONFLICT");
}

export function useBodyConflicts() {
  return useConflictEvents("BODY_CONFLICT");
}

function useConflictEvents(eventType: "ATTRIBUTE_CONFLICT" | "BODY_CONFLICT") {
  const { events } = useLiveEventLog({
    query: { event_type: eventType, limit: "50" },
    intervalMs: 8000,
    maxEvents: 100,
  });
  const [dismissed, setDismissed] = useState<Set<number>>(readDismissed);
  function dismiss(eventId: number) {
    setDismissed((prev) => {
      const next = new Set([...readDismissed(), ...prev, eventId]);
      const key = storageKey();
      if (key) writeSession(key, JSON.stringify([...next])); // blocked or full: hidden until reload
      return next;
    });
  }
  return { conflicts: events.filter((e) => !dismissed.has(e.id)), dismiss };
}
