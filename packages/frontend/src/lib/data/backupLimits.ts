// How large a backup this server restores, and how large a backup would be (backend routes/backup.ts GET
// /restore/limit and /size). A backup downloads at any size; restoring stops at the server's limit, so the page says
// so beside both buttons. Both answers are advice: a server that cannot answer (offline, older) leaves the default
// limit (the same number nginx states) and no size, and the server's own refusal stays the last word.

import { DEFAULT_MAX_BACKUP_REQUEST_BYTES } from "@onden/markdown";
import { api } from "../api";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A size in plain units: "1.5 GB", "800 MB". */
export function sizeLabel(bytes: number): string {
  return bytes >= GB ? `${Number((bytes / GB).toFixed(1))} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;
}

export const backupLimits = {
  /** The largest backup the server restores, in bytes. */
  restoreLimitBytes: (): Promise<number> =>
    api<{ max_bytes: number }>("/api/backup/restore/limit").then((answer) => answer.max_bytes, () => DEFAULT_MAX_BACKUP_REQUEST_BYTES),
  /** What a full backup would weigh (without version history), or null when the server cannot say. */
  downloadBytes: (): Promise<number | null> =>
    api<{ bytes: number }>("/api/backup/size").then((answer) => answer.bytes, () => null),
};
