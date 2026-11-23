// The earlier versions of the notes this device took from a file (backend services/stampedSnapshotStream.ts): the notes came, their earlier versions
// did not all come, and the person stops waiting for them (POST /api/snapshot/history/stop: what had arrived of them is removed, the notes stay).
// Online only, never queued: it is an answer to a question on screen (browserApp/BringNotes.tsx, settings/DeviceFileSetting.tsx).

import { DEVICE_FILE_PATH } from "@onden/markdown/contract";
import { postRead } from "../api";

export const deviceFileHistory = {
  /** Resolves when the device no longer waits for the earlier versions; throws an `ApiError` whose message is the plain sentence. */
  stopWaiting: (): Promise<{ removed: number }> => postRead<{ removed: number }>(`${DEVICE_FILE_PATH}/history/stop`),
};
