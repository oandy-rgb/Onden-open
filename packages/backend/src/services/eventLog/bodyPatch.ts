// Body-markdown patch utilities for event restoration.
//
// Stores the inverse of a body change as a diff-match-patch unified text
// patch in domain_events.tx_meta.inverse_patch. Applied to the event's OWN
// post body (its blob, payload.body_hash) it rebuilds the OLD body exactly;
// reverting on top of later edits is then a three-way merge (eventRestore,
// bodyMerge.ts), never a fuzzy apply on the current body (D79).
//
// Why a patch, not a full prev_body snapshot:
//   For typical markdown edits — typo fixes, line insertions, paragraph
//   tweaks — the patch is <5% of body size. A 100KB note with a 1-line
//   change produces a ~300 byte patch instead of duplicating the full body.
//   For total rewrites the patch approaches body size (no worse than
//   storing prev_body), so this is strictly equal-or-better.
//
// Reference pattern (memory/feedback_problem_solving_reference_first):
//   etherpad-develop/src/static/js/Changeset.ts exports `inverse()` which
//   produces a deterministic inverse changeset for any forward changeset.
//   Etherpad's changeset format is OT-flavoured (it tracks attribute pools
//   for rich text); we use the simpler diff-match-patch plain-text format
//   because Onden's body is markdown, not rich-text-with-attributes.
//
// Why not Joplin's `Revision.createTextPatch` (RevisionService.ts):
//   Joplin's approach is also diff-match-patch-based but stores the patch
//   as the entire revision content. Onden separates concerns: the BODY
//   already lives in the blob layer (migration 030, content-addressable);
//   tx_meta.inverse_patch is ONLY the revert delta. So Joplin stores
//   "what this revision LOOKS LIKE"; we store "how to undo this event".
//
// Limitations (honest):
//   - patch_apply is fuzzy: on a body other writers changed, a hunk whose
//     context still matches reports "applied" and lands over their edit.
//     So it runs only on the event's own post body (rebuildPreEventBody).
//   - diff-match-patch is char-based, not line-based. For very large
//     bodies (>1 MB) the algorithm slows; not a concern for note-app
//     markdown.

import DMP from "diff-match-patch";
import { NO_INVERSE_PATCH } from "../../spine/inversePatch.js";

const dmp = new DMP();

/**
 * Make an inverse patch: applying it to `newBody` reconstructs `oldBody`.
 *
 * Returns the unified patch text. Empty string when the bodies are equal
 * (no-op patch); applying an empty patch is also a no-op. NO_INVERSE_PATCH
 * when the text cannot be encoded as a patch at all: "body unchanged" and "no
 * way back" are different answers to a restore (restore.ts history_incomplete).
 *
 * @param oldBody  state to revert TO
 * @param newBody  state we're reverting FROM (the current/just-committed body)
 */
export { NO_INVERSE_PATCH };

export function makeInversePatch(oldBody: string, newBody: string): string {
  if (oldBody === newBody) return "";
  // patch_make(a, b) builds a patch that turns `a` into `b`. For an INVERSE
  // we want a patch that turns the new body BACK into the old, so we pass
  // newBody as the source and oldBody as the destination.
  const patches = dmp.patch_make(newBody, oldBody);
  try {
    return dmp.patch_toText(patches);
  } catch {
    // Known diff-match-patch bug (google/diff-match-patch#69): the char-based
    // diff can split a UTF-16 surrogate pair across diff boundaries (e.g.
    // 😀→😁 share the high surrogate \uD83D, so the diff keeps it as EQUAL
    // text and swaps only the low surrogate). patch_toText then runs
    // encodeURI over a lone surrogate and throws "URI malformed" — which,
    // pre-fix, 500'd every PATCH /api/nodes whose edit landed inside an
    // emoji. Fall back to a full-replacement patch: both bodies are
    // well-formed strings, so nothing is split and encoding succeeds. Bigger
    // than a minimal diff (== storing prev_body) but strictly correct.
    try {
      const full: Array<[number, string]> = [
        [DMP.DIFF_DELETE, newBody],
        [DMP.DIFF_INSERT, oldBody],
      ];
      return dmp.patch_toText(dmp.patch_make(newBody, full));
    } catch {
      // Input itself contains lone surrogates (possible via JSON \uD800
      // escapes) — no encodable patch exists. Degrade to "no inverse"
      // (restore unavailable for this one event) rather than failing the
      // user's save.
      return NO_INVERSE_PATCH;
    }
  }
}

/**
 * Rebuild the body before an event from the body that event LEFT — its own
 * post blob (payload.body_hash). The patch was cut from exactly that text, so
 * every hunk lands where it was made: the result is the pre-event body, not a
 * guess. Null when a hunk does not apply. Throws when the patch is malformed.
 *
 * The only patch_apply in the code base (bodyPatchGuard.test.ts). Never pass
 * a body other writers may have changed since the event: patch_apply is
 * fuzzy, and a hunk whose context still matches "applies" over their edit
 * (D79). To revert on top of later edits, rebuild here and three-way merge
 * (bodyMerge.ts), as eventRestore does.
 */
export function rebuildPreEventBody(postBody: string, inversePatch: string): string | null {
  if (!inversePatch) return postBody;
  const [result, applied] = dmp.patch_apply(dmp.patch_fromText(inversePatch), postBody);
  return applied.every((ok) => ok === true) ? result : null;
}

/**
 * For events stored without a post blob (legacy): rebuild the pre-event body
 * from `body` only when `body` is still what the event left, as far as the
 * patch can tell — the inverse made from the rebuilt body back to `body` is
 * the stored patch itself (same hunks, same context, same offsets). Null
 * otherwise: with no post body there is nothing to merge against, and applying
 * the patch anyway is the fuzzy revert that overwrote other writers' text.
 */
export function rebuildFromUnchangedBody(body: string, inversePatch: string): string | null {
  const pre = rebuildPreEventBody(body, inversePatch);
  return pre !== null && makeInversePatch(pre, body) === inversePatch ? pre : null;
}

/** A plain diff of two strings: [-1 deleted | 0 equal | 1 inserted, text] runs.
 *  For bodyMerge.ts (the line-based three-way merge), which diffs one character
 *  per line, so diff-match-patch is still imported only here. */
export function diffRuns(a: string, b: string): Array<[-1 | 0 | 1, string]> {
  return dmp.diff_main(a, b, false) as Array<[-1 | 0 | 1, string]>;
}
