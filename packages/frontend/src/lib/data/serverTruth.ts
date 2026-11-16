// The one way a device takes the server's answer about a note's place back
// after its own optimistic change was refused, or was answered differently
// than it was drawn (a move to a note's own descendant, a delete of a note the
// server already deleted, a parent the server read as "top level").
//
// Why a read and not "put back what I remember": the device drew the change
// before the server answered, the sync cursor has moved on, and no later delta
// repairs a row whose server value did not change. The server's current row
// (or its absence) is the only value that is right whatever happened meanwhile.
// Callers: the note writer when a write is refused (noteWriter.ts) and the
// queue when a replayed write is refused or answered differently (writeQueue.ts).

import { api, ApiError, type Bootstrap, type ContentNode } from "../api";
import { persistRemoteNode, removeNode } from "../localDb";
import { dropNode, patchNode } from "./storeOps";

type SetData = (update: (state: Bootstrap) => Bootstrap) => void;

/** True when the server's row (or the note's absence) is now what the screen
 *  and the local copy show; false when the server could not be asked (offline,
 *  a server error), so the caller keeps whatever it has. */
export async function settleNodeToServer(id: string, setData: SetData): Promise<boolean> {
  let row: ContentNode;
  try { row = await api<ContentNode>(`/api/nodes/${id}`); }
  catch (error) {
    // The server answered that the note is not there for this person (gone, or not readable).
    if (error instanceof ApiError && [403, 404, 410].includes(error.status)) {
      setData((state) => dropNode(state, id));
      await removeNode(id).catch(() => null);
      return true;
    }
    return false;
  }
  // Where the note is (not its text).
  const place: Partial<ContentNode> = { parent_id: row.parent_id ?? null, order_key: row.order_key, order_stamp: row.order_stamp, ...(row.hidden === undefined ? {} : { hidden: row.hidden }) };
  setData((state) => patchNode(state, id, place));
  // Text a person still has queued is projected onto the stored row by the worker.
  await persistRemoteNode(row).catch(() => null);
  return true;
}
