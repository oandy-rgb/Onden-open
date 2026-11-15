// How a design edit is saved, for both website screens: scheduled on the autosave under one key, and
// "dirty" until a save of exactly that edit has been accepted — only then does the screen follow the
// stored design again. A save refused as stale hands over to `onStale`, which reloads the server's.
import type { createAutosave } from "../../../lib/data";
import { isDesignStale } from "../websiteWriter";

type AutosaveSave = Parameters<ReturnType<typeof createAutosave>["schedule"]>[1];
type Refs<D> = { dirty: { current: boolean }; sent: { current: D | null } };

/** The label of the autosave's state, as the English words the screens translate (undefined when idle). */
export const SAVE_STATUS_TEXT: Record<string, string> = {
  synced: "Website changes saved", queued: "Website changes saved locally", saving: "Saving website changes…", error: "Website changes not saved",
};

export function queueDesignSave<D>(
  autosave: ReturnType<typeof createAutosave>, refs: Refs<D>, next: D,
  save: AutosaveSave, onStale: () => void,
): void {
  refs.dirty.current = true; refs.sent.current = next;
  autosave.schedule("design", (options) => {
    const saving = save(options);
    void saving.then((result) => {
      // Saved and not edited since: follow the stored design again.
      if (result.status === "synced" && refs.sent.current === next) { refs.dirty.current = false; refs.sent.current = null; }
    }, (error: unknown) => { if (isDesignStale(error)) onStale(); });
    return saving;
  });
}
