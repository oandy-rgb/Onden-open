import { reloadPage } from "../lib/api";
import { useEffect, useSyncExternalStore } from "react";
import { confirmDialog } from "../components/ConfirmDialog";
import { dataSync, localCopy, WriteActionError, writeErrors } from "../lib/data";
import { downloadBlob } from "../lib/download";
import { t } from "../lib/i18n";
import { todayId } from "../lib/localDate";
import { localDbErrorCode } from "../lib/localDbErrors";

// This device's copy (the SQLite file): download it, or replace it from a file.
// The download row and the restore row are separate registry entries (restore
// closes the page, in red), so they share one operation state here: while one
// runs, neither starts another.

export function storageFailure(error: unknown, message: string): string {
  console.error("[onden] local backup operation failed", error);
  if (localDbErrorCode(error) === "backup_foreign_account") {
    return t("The backup must belong to the current account and server");
  }
  return writeErrors.message(error instanceof WriteActionError ? error : new WriteActionError(t(message), { cause: error }));
}

type State = { operation: "export" | "import" | null; exportError: string | null; importError: string | null; notice: string | null };
let state: State = { operation: null, exportError: null, importError: null, notice: null };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; for (const l of listeners) l(); };

async function handleExport() {
  if (state.operation) return;
  set({ operation: "export", exportError: null, notice: null });
  try {
    // The bootstrap carries no drawings: fetch the ones this device lacks
    // first, and say so when some could not be (offline, a failed request)
    // rather than write a backup that silently lacks them.
    const drawings = await dataSync.downloadDrawings({ force: true });
    if (!drawings.complete) {
      set({
        notice: drawings.missing === null
          ? t("Some drawings may be missing from this backup: they are not on this device yet. Connect to the server and download it again to include them.")
          : drawings.missing > 0
            ? t("{count} drawings are missing from this backup: they are not on this device yet. Connect to the server and download it again to include them.", { count: drawings.missing })
            : null,
      });
    }
    const file = await localCopy.exportFile();
    // The workspace's day, as the agenda and daily notes count it (UTC was a
    // day behind before 08:00 in Taiwan).
    downloadBlob(file, `onden-backup-${todayId()}.sqlite3`);
  } catch (error) {
    set({ exportError: storageFailure(error, "Could not create a local backup. Keep this page open and try again.") });
  } finally { set({ operation: null }); }
}

async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  e.target.value = ""; // The same file can be selected again after a failure.
  if (!file) return;
  if (state.operation) return;
  set({ operation: "import", importError: null });
  try {
    if (!(await confirmDialog(t("Replace this device's local snapshot and queued changes with the backup? This does not restore data on the server."), { confirmLabel: t("Overwrite & import"), cancelLabel: t("Cancel"), danger: true }))) return;
    await localCopy.importFile(await file.arrayBuffer());
    reloadPage();
  } catch (error) {
    set({ importError: storageFailure(error, "Could not restore this backup. Use an Onden backup from this workspace and check available storage. The current local database was kept.") });
  } finally { set({ operation: null }); }
}

export function useDeviceCopy() {
  // Errors belong to the visit: leaving the page and coming back starts clean.
  useEffect(() => { if (!state.operation) set({ exportError: null, importError: null, notice: null }); }, []);
  const snapshot = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);
  return { ...snapshot, handleExport, handleImport };
}
