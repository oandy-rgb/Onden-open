// The saving half of an ink surface — shared by every host that keeps a drawing in a note's attribute
// (the content tab's handwriting page and PDF in OverviewEditor, the 「手寫」 tab's pane): remember which drawing
// the next save is made from, and move that forward only as the server answers.

import { useCallback, useRef } from "react";
import { saveInk, type InkSaveDoc, type InkSaveOptions } from "../data";

type Remembered = { nodeId: string; doc: InkSaveDoc | null };

/** `attr` is the attribute the surface keeps its drawing in (default `ink_data`; `note_ink` for the 手寫 tab). */
export function useInkSurfaceSaver(attr?: InkSaveOptions["attr"]) {
  // The drawing a surface's next save was made from — what loaded, then each save — sent with it so the server
  // merges the save into what another device stored meanwhile (lib/data/inkWriter).
  const baseRef = useRef<Remembered | null>(null);
  // The last base the server is known to hold (what loaded, then each save it took).
  const acceptedRef = useRef<Remembered | null>(null);

  /** What a surface loaded: the base of its first save (null: the note had no drawing). */
  const rebase = useCallback((nodeId: string, doc: InkSaveDoc | null) => {
    baseRef.current = { nodeId, doc };
    acceptedRef.current = baseRef.current;
  }, []);

  const save = useCallback((nodeId: string, next: InkSaveDoc, options?: InkSaveOptions) => {
    const base = baseRef.current?.nodeId === nodeId ? baseRef.current.doc : undefined;
    // The next save is made from this one at once (a stroke drawn then undone before the
    // answer must read as removed); a save the server refused never reached it, so the base
    // goes back to the last one it has.
    const sent = saveInk(nodeId, next, base, attr ? { ...options, attr } : options);
    baseRef.current = { nodeId, doc: next };
    void Promise.resolve(sent).then((saved) => {
      if (saved) acceptedRef.current = { nodeId, doc: next };
      else if (baseRef.current?.nodeId === nodeId) baseRef.current = acceptedRef.current?.nodeId === nodeId ? acceptedRef.current : null;
    });
  }, [attr]);

  return { rebase, save };
}
