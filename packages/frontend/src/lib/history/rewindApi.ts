// 「那天的樣子」 and 「還原到這時」: the server calls behind the rewind preview, its confirmation and the
// feed's rewind card (docs/architecture/history-api.md). The read goes through reads.history; the rewind
// and its undo are writes, made by historyWriter (lib/data/noteHistoryWriter.ts).
import { reads } from "../data";
import type { NoteAt, WorkspaceAt } from "@onden/contract";

export function fetchWorkspaceAt(at: string, space: string | null = null): Promise<WorkspaceAt> {
  return reads.history.at<WorkspaceAt>(at, space ?? undefined);
}
export function fetchNoteAt(id: string, at: string, space: string | null = null): Promise<NoteAt> {
  return reads.history.atNote<NoteAt>(id, at, space ?? undefined);
}

export type RewindRequest = { t: string; space?: string; restore_ids: string[]; undelete_ids: string[]; delete_ids: string[] };
