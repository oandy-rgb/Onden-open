// "It is me, just now": the one way a page gets the short-lived, single-use ticket a guarded route asks for (backend services/freshProof.ts,
// POST /api/fresh-proof). The page presents evidence once (the password; the browser version, whose one local person has a public password,
// an acknowledgement) and carries the ticket in the request that needs it. Online only, never queued: a ticket is good for two minutes and one
// use, so a retry means confirming again. The dialog that asks is components/ReconfirmDialog.tsx.

import { ApiError, postRead } from "../api";

/** What a ticket is for (backend FRESH_PROOF_PURPOSES): a ticket made for one thing never opens another. */
export type FreshProofPurpose = "snapshot_export";
type FreshProofEvidence = { kind: "password"; password: string } | { kind: "acknowledgement" };

export const freshProof = {
  /** Resolves the ticket; throws an `ApiError` whose message is the plain sentence (wrong password, locked for a while, no password on this account…). */
  issue: (purpose: FreshProofPurpose, evidence: FreshProofEvidence): Promise<string> =>
    postRead<{ ticket: string; expires_in_seconds: number }>("/api/fresh-proof", { purpose, evidence }).then((answer) => answer.ticket, (error: unknown) => {
      // Only the code is kept: serverErrors words a code in the person's language, but shows an English `detail` as it came in an English page.
      throw error instanceof ApiError ? new ApiError(error.status, JSON.stringify({ error: error.code })) : error;
    }),
};
