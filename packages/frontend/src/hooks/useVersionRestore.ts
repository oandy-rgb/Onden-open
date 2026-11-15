import { useRef, useState } from "react";
import { nodeMutations } from "../lib/data";
import { drafts, writeErrors } from "../lib/data";
import { t } from "../lib/i18n";

export type VersionRestoreOutcome = { status: "applied" | "refused"; message: string };

/** Restore a saved version through the same draft and writer contract in every
 * view. Applied means acknowledged, even if the resulting note needs a refresh.
 * Refused keeps the caller's preview open. The writer owns error notifications
 * and retry keys; this boundary exposes feedback without a second toast. */
export function useVersionRestore() {
  const busy = useRef(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<(VersionRestoreOutcome & { nodeId: string }) | null>(null);

  async function restore(nodeId: string, versionId: string, choice: { restoreTitle: boolean }): Promise<VersionRestoreOutcome> {
    if (busy.current) return { status: "refused", message: t("A restore is already running.") };
    busy.current = true;
    setRestoringVersionId(versionId);
    setFeedback(null);
    let outcome: VersionRestoreOutcome;
    try {
      let loaded = false;
      const applied = await drafts.restore(nodeId, async () => {
        const note = await nodeMutations.restoreVersion(nodeId, versionId, choice);
        loaded = note !== undefined;
        return note;
      });
      outcome = applied
        ? { status: "applied", message: t(loaded ? "Version restored" : "The change is saved. Refresh to load the latest details.") }
        : { status: "refused", message: t("The restore was not started. Keep your draft and try again.") };
    } catch (error) {
      outcome = { status: "refused", message: writeErrors.message(error) };
    } finally {
      busy.current = false;
      setRestoringVersionId(null);
    }
    setFeedback({ ...outcome, nodeId });
    return outcome;
  }

  return { restore, restoringVersionId, feedback };
}
