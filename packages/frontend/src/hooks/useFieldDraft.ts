import { useRef } from "react";
import { useCardDraft } from "./useCardDraft";

/** What a field's commit gets: `base` is the text the edit started from. */
export type FieldCommitOptions = { keepalive?: boolean; base: string };

/** A field with an uncommitted draft (an attribute box, a table cell, a title). The caller commits on blur / Enter
 *  with `flush()` as before; this also commits when the field unmounts and when the page is hidden or closed, so
 *  typed text is not lost to a tab close, an app kill or a note switch with no blur.
 *
 *  The commit always goes to the `target` the text was typed on (captured at the first keystroke), never to whatever
 *  the field points at when it fires. It is useCardDraft with autosave off: same handoff to the existing writer, the
 *  writer reports failures, the draft stays visible after one, and an unchanged text sends nothing. A field shows
 *  `text` only while its target is the one the draft was typed on.
 *
 *  Leaving ignores an input method that is composing: the text is already what the person typed. */
export function useFieldDraft<Target>(args: {
  target: Target;
  /** Identity of `target`; a different key is a different field (another note, row or column). */
  targetKey: string;
  /** The saved text now. */
  committed: string;
  commit: (target: Target, text: string, options: FieldCommitOptions) => Promise<unknown> | void;
}) {
  const { target, targetKey, committed, commit } = args;
  const startedOn = useRef<{ key: string; target: Target } | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  // useCardDraft's own key is the draft's target: when it changes, its cleanup hands the old draft to the old target.
  const card = useCardDraft(targetKey, committed, (key, text, options) => {
    const from = startedOn.current;
    // The key is the one the draft was typed on; the target is the one captured then.
    if (!from || from.key !== key) return;
    return commitRef.current(from.target, text, options);
  }, { autosave: false });
  const typedHere = startedOn.current?.key === targetKey;
  return {
    /** The text to show: the draft while it belongs to this field, else the saved text. */
    text: typedHere ? card.content : committed,
    /** Whether the draft is being sent (read-only while it is) or was refused (kept for another try). */
    status: typedHere ? card.status : "idle" as const,
    edit(next: string) {
      if (startedOn.current?.key !== targetKey) {
        // The previous target's draft was handed to it when the key changed; none of its state carries over.
        if (startedOn.current) card.discard();
        startedOn.current = { key: targetKey, target };
      }
      card.edit(next);
    },
    /** Commit now (blur, Enter). Resolves true when accepted or there was nothing to send. */
    flush: card.flush,
    /** Send a refused draft again (a 「重試」 button). */
    retry: card.retry,
    /** Drop the draft without sending it (Escape). */
    discard: card.discard,
  };
}
