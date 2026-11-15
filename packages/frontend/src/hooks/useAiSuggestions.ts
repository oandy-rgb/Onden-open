import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addToast } from "../lib/appStore";
import { drafts, onlineOperation, reads } from "../lib/data";
import { t } from "../lib/i18n";
import { useLiveRefetch } from "../lib/liveInvalidation";
import { announceSuggestionsChanged, onSuggestionsChanged } from "../lib/aiSuggestionsBus";
import {
  decisionNotice, layoutSuggestions, placesInOrder, type Decision, type Place, type SuggestionLayout, type SuggestionsView,
} from "../lib/aiSuggestions";

type DecideResult = { accepted?: string[]; rejected?: string[]; stale?: string[]; void?: string[]; alreadyDecided?: string[] };

/** The AI suggestions of the open note: what is pending, where each place is
 *  in the text now, and the two things a person does — accept, reject — for
 *  one place or all of them. A decision goes through the one online write path
 *  (an Idempotency-Key per attempt, so a retry after a lost reply is the same
 *  decision), never the offline queue: nothing here says "accepted" before the
 *  server did. Accepting writes the note on the server, so the note's own
 *  unsaved text is saved first; if that fails nothing is sent and the text is
 *  kept. After a decision the list is read again, and the note itself comes
 *  back through the app's usual refresh.
 *  `onNoteChanged` is called once the server changed the note (accept). */
export function useAiSuggestions({ nodeId, markdown, canEdit, online, onNoteChanged }: {
  nodeId: string | undefined; markdown: string; canEdit: boolean; online: boolean; onNoteChanged?: () => void;
}) {
  const [view, setView] = useState<SuggestionsView | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const nodeRef = useRef(nodeId);
  nodeRef.current = nodeId;
  const busyRef = useRef(false);
  const changedRef = useRef(onNoteChanged);
  changedRef.current = onNoteChanged;

  // A different note: nothing of the last one is kept.
  useEffect(() => { setView(null); setBusy(new Set()); }, [nodeId]);

  const refresh = useCallback(async () => {
    const id = nodeRef.current;
    if (!id) return;
    try {
      const body = await reads.aiSuggestions.forNote<SuggestionsView>(id);
      if (nodeRef.current === id) setView(body.suggestions.length > 0 ? body : null);
    } catch { /* offline or not allowed: what we last knew stays */ }
  }, []);

  // Looked up when a note opens (and when the connection returns).
  useEffect(() => {
    if (!nodeId || !online) return;
    void refresh();
  }, [nodeId, online, refresh]);
  // What an AI proposes while the note is open appears at once: filing a suggestion is an event, and the live "changed"
  // signal that already refreshes the inbox reads the note's places again (the echo of this tab's own decisions is folded).
  useLiveRefetch("changed", () => refresh(), { onReconnect: false, collapseEcho: true });

  // The info panel's AI answer filed or decided places: read them again (and the note, when a place was accepted).
  useEffect(() => onSuggestionsChanged((change) => {
    if (change.nodeId !== nodeRef.current || change.fromEditor) return;
    void refresh();
    if (change.noteChanged) changedRef.current?.();
  }), [refresh]);

  const layout: SuggestionLayout = useMemo(
    () => layoutSuggestions(view, { markdown, canEdit, online, busy }),
    [view, markdown, canEdit, online, busy],
  );

  /** Decide items of one suggestion. Resolves true when the server took it. */
  const decide = useCallback(async (suggestionId: string, itemIds: string[] | "all", decision: Decision): Promise<boolean> => {
    const id = nodeRef.current;
    if (!id || busyRef.current) return false;
    busyRef.current = true;
    const marked = itemIds === "all"
      ? (view?.suggestions.find((s) => s.id === suggestionId)?.items.map((i) => i.id) ?? [])
      : itemIds;
    setBusy(new Set(marked));
    try {
      if (decision === "accept" && !(await drafts.flush())) {
        addToast(t("The note couldn't be saved, so nothing was accepted. Your text is kept."), "error");
        return false;
      }
      const result = await onlineOperation(`ai-suggestion:${id}:${suggestionId}`, t("Accepting or rejecting needs a connection."),
        (submit) => submit<DecideResult>(`/api/ai-suggestions/${suggestionId}/${decision}`, JSON.stringify({ item_ids: itemIds })));
      if (!("deduped" in result)) {
        const notice = decisionNotice(result);
        if (notice) addToast(notice, "info");
        if (decision === "accept" && (result.accepted?.length ?? 0) > 0) changedRef.current?.();
      } else if (decision === "accept") changedRef.current?.();
      await refresh();
      // The review card in the inbox and the count on the note follow what is still undecided.
      announceSuggestionsChanged(id, false, true);
      return true;
    } catch { return false; /* the online write path already told the person why; the places stay so they can try again */ }
    finally {
      busyRef.current = false;
      setBusy(new Set());
    }
  }, [view, refresh]);

  const onDecide = useCallback((place: Place, decision: Decision) => { void decide(place.suggestionId, [place.itemId], decision); }, [decide]);

  const decideAll = useCallback(async (decision: Decision) => {
    // One request per suggestion (a person sees one list; the server keeps sets apart).
    for (const s of view?.suggestions ?? []) {
      const ids = s.items.filter((i) => i.status === "pending").map((i) => i.id);
      if (ids.length === 0) continue;
      if (!(await decide(s.id, ids, decision))) return;
    }
  }, [view, decide]);

  const ordered = useMemo(() => placesInOrder(layout.places), [layout.places]);

  return { layout, view, decide, decideAll, onDecide, ordered, refresh, busy: busy.size > 0 };
}
