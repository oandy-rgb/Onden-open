// The headers of a single note read (GET /api/nodes/:id), re-exported by sharedContract.ts (@onden/markdown/contract).

/** Where a single read was taken from (decimal string): the workspace's event head read BEFORE the row, so the row holds
 *  at least every write up to it. The app judges the read by it like any other answer (frontend lib/answerPositions.ts). */
export const READ_HEAD_HEADER = "X-Onden-Read-Head";

/** Which server's log that head counts in: the same derived identity as every sync answer's `server_id`. Without it a
 *  single read taken just after the server changed identity would be judged against the old log's positions. */
export const READ_SERVER_HEADER = "X-Onden-Read-Server";
