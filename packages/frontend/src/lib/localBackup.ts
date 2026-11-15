import { getStoragePref, pickDirectory, readDbFromDir, setStoragePref, storeDirHandle, writeDbToDir } from "./fileSystemStorage";
import { WriteActionError, dataSync, localCopy } from "./data";
import { t } from "./i18n";

/** Copy the current local snapshot, then activate its folder. Returns false on
 * picker cancellation. A folder containing a database is never overwritten.
 * Failure before activation keeps the previous location; a copied file may
 * remain if the browser cannot save the directory setting. */
export async function chooseLocalBackupFolder(): Promise<boolean> {
  const handle = await pickDirectory();
  if (!handle) return false;
  if (await readDbFromDir(handle)) {
    throw new WriteActionError(t("This folder already contains an Onden database. Choose an empty folder to keep that copy safe."));
  }
  // The folder copy holds every drawing, not only those opened here.
  await dataSync.downloadDrawings({ force: true });
  const file = await localCopy.exportFile();
  await writeDbToDir(handle, file);
  const previous = getStoragePref();
  await storeDirHandle(handle);
  // For an existing folder the committed handle is the whole change. Avoid
  // a second, fallible preference write after that commit point.
  if (previous !== "fs-access") setStoragePref("fs-access");
  return true;
}

/** Preserve the latest snapshot in browser storage before changing location.
 * The old folder and its saved file remain available; no deletion is needed. */
export async function switchToBrowserStorage(): Promise<void> {
  await localCopy.flush();
  setStoragePref("opfs"); // Legacy setting value; current implementation is IDB.
}
