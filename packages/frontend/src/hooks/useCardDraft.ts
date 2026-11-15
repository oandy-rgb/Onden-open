import { useCallback, useEffect, useRef, useState } from "react";
import { createSaveDebounce, SAVE_DEBOUNCE_MS } from "../lib/persistScheduler";
import { onPageHide } from "../lib/pageHide";

/** `base`: the body this card's input was typed onto, the three-way-merge base
 *  (draftActions.saveNoteBody), so another writer's newer lines survive. */
export type SaveCardBody = (nodeId: string, content: string, options: { keepalive?: boolean; base: string }) => Promise<unknown> | void;
type PendingInput = { revision: number; content: string };

/** One mounted React Flow card owns its unsent input. Flush hands it to the
 * existing note writer synchronously; the returned promise confirms acceptance.
 * Failure keeps the visible draft and never retries by itself. Unmount/pagehide
 * hand off only new input. Queue/storage recovery and error classification stay
 * in the writer, including a directly refused input's recovery copy. This hook
 * does not silently restore a refused draft over accepted note content.
 * CardNode must remain keyed by node ID, as it is in React Flow.
 * `autosave: false`: nothing is sent while typing (a field saved when the person finishes it, see useFieldDraft). */
export function useCardDraft(nodeId: string, content: string, save: SaveCardBody, options: { autosave?: boolean } = {}) {
  const autosave = options.autosave ?? true;
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "unsaved" | "saving" | "rejected">("idle");
  const revision = useRef(0);
  const pending = useRef<PendingInput | null>(null);
  const failed = useRef<PendingInput | null>(null);
  const active = useRef<Promise<boolean> | null>(null);
  const debounce = useRef(createSaveDebounce(SAVE_DEBOUNCE_MS.card)).current;
  const mounted = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;
  // The body the next send builds on, read when it is SENT: the shown content
  // when editing starts, then the previous send (the note's saves apply in
  // order). A refused send hands its own base back to the input after it.
  const base = useRef<string | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const flush = useCallback((options: { keepalive?: boolean } = {}): Promise<boolean> => {
    debounce.cancel();
    const input = pending.current;
    if (!input) return active.current ?? Promise.resolve(failed.current === null);
    pending.current = null;
    if (mounted.current) setStatus("saving");
    // Do not defer the writer invocation: blur must update its optimistic state
    // before the next click can export or reopen the same note.
    let operation: Promise<unknown> | void;
    const sentOn = base.current ?? contentRef.current;
    base.current = input.content;
    // Typed and typed back to what the note holds: nothing to send (no history point).
    try { operation = input.content === sentOn ? undefined : saveRef.current(nodeId, input.content, { keepalive: !!options.keepalive, base: sentOn }); }
    catch (error) { operation = Promise.reject(error); }
    const saving = Promise.resolve(operation).then(() => {
      if (revision.current === input.revision) {
        failed.current = null;
        // Settled: the next edit starts from the content shown then.
        if (!pending.current) base.current = null;
        if (mounted.current) { setDraft(null); setStatus("idle"); }
      }
      return true;
    }, () => {
      // The writer has reported the failure.
      if (base.current === input.content) base.current = sentOn;
      if (revision.current === input.revision) {
        failed.current = input;
        if (mounted.current) { setDraft(input.content); setStatus("rejected"); }
      }
      return false;
    });
    active.current = saving;
    void saving.then(() => { if (active.current === saving) active.current = null; });
    return saving;
  }, [nodeId, debounce]);

  function edit(next: string) {
    base.current ??= contentRef.current;
    pending.current = { revision: ++revision.current, content: next };
    failed.current = null;
    setDraft(next);
    setStatus("unsaved");
    if (autosave) debounce.run(() => { void flush(); });
  }

  /** Drop the unsent input without sending it (Escape): the next flush has nothing to hand off. */
  function discard() {
    debounce.cancel();
    pending.current = null;
    failed.current = null;
    base.current = null;
    revision.current++;
    setDraft(null);
    setStatus("idle");
  }

  function retry() {
    if (!failed.current) return flush();
    pending.current = failed.current;
    failed.current = null;
    return flush();
  }

  useEffect(() => {
    mounted.current = true;
    const onHide = () => { void flush({ keepalive: true }); };
    const offPageHide = onPageHide(onHide);
    return () => {
      mounted.current = false;
      offPageHide();
      void flush();
    };
  }, [flush]);

  return { content: draft ?? content, status, edit, discard, flush, retry };
}
