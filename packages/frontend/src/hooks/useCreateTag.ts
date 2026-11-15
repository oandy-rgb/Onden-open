import { useCallback } from "react";
import { addToast } from "../lib/appStore";
import { tagWriter, writeErrors } from "../lib/data";

/**
 * Create a tag and land on it (TagsMode retirement: tag creation lives in the
 * sidebar tag panel and the tags page). Creation is tagWriter.create — the
 * same plain tag a `#name` in a note makes — then opens the new tag's node to
 * shape it there.
 */
export function useCreateTag(openNewTag: (id: string) => void) {
  return useCallback(async (name: string) => {
    // Offline-parity: createTag client-mints the class_tag id, optimistically
    // inserts the tag (node + Tag row), and queues POST /api/tags — so
    // "+ new tag" works offline and lands on the tag's lens instantly.
    try {
      const { id, queued } = await tagWriter.create(name);
      openNewTag(id);
      if (queued) addToast(writeErrors.queuedMessage(), "info");
    } catch (e) {
      // The tag writer may already have reported this error; the shared reporter
      // shows each failure once, in the error style.
      writeErrors.report(e, addToast);
    }
  }, [openNewTag]);
}
