// What core calls into the review module for (services/reviewSeam.ts),
// installed when this file loads: a card's schedule moving between a note and
// a block node, as its text does (block-nodes.md 「搬成子筆記」).

import { q } from "../../db.js";
import { installReviewSeam, type ReviewTarget } from "../../services/reviewSeam.js";
import { deleteOwnRefViaWord, insertOwnRef, markOwnRefViaWord, moduleWordNames, ownRefId } from "../../services/functionRefs.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";
import { REVIEW_FUNCTION_ID } from "./cards.js";

/** The words a paragraph's `{…}` may carry to be a card: `review` and its Chinese name, each unless an ordinary tag already has
 *  that name, plus the title of a review module tag that still exists (a person's own name for it, or the 複習 that stayed). */
const DEFAULT_WORDS = ["review", "複習"] as const;
async function cardWords(workspaceId: string): Promise<string[]> {
  const { marked, ordinary } = await moduleWordNames(workspaceId, REVIEW_FUNCTION_ID, DEFAULT_WORDS);
  return [...new Set([...marked, ...DEFAULT_WORDS.filter((word) => !ordinary.includes(word))])];
}

/** A card's column in review_states: a note's or a block node's (one table since migration 183). */
const keyOf = (target: ReviewTarget) => ("note" in target ? "node_id" : "block_id");
const idOf = (target: ReviewTarget) => ("note" in target ? target.note : target.block);

installReviewSeam({
  cardWords,
  async markCards({ workspaceId, holders, actor, via }) {
    if (!(await workspaceHasModule(workspaceId, "review"))) return;
    for (const holder of holders) {
      if (via === "word") await markOwnRefViaWord(workspaceId, holder, REVIEW_FUNCTION_ID, { by: actor });
      else await insertOwnRef(workspaceId, holder, REVIEW_FUNCTION_ID, { by: actor });
    }
  },
  async unmarkCardsWord({ holders }) {
    for (const holder of holders) await deleteOwnRefViaWord(holder, REVIEW_FUNCTION_ID);
  },
  async copyProgress(workspaceId, from, to) {
    const source = keyOf(from), dest = keyOf(to);
    // A card stays a card in its new place: the destination holds the reference too (the source keeps its own).
    const sourceRef = await ownRefId({ kind: "block" in from ? "block" : "node", id: idOf(from) }, REVIEW_FUNCTION_ID);
    if (sourceRef) await insertOwnRef(workspaceId, { kind: "block" in to ? "block" : "node", id: idOf(to) }, REVIEW_FUNCTION_ID);
    // The schedule reviewed last wins where both have one.
    await q(
      `INSERT INTO review_states (workspace_id, ${dest}, actor_id, state, previous_state, updated_at)
       SELECT workspace_id, $3::uuid, actor_id, state, previous_state, updated_at
         FROM review_states WHERE workspace_id = $1 AND ${source} = $2
       ON CONFLICT (${dest}, actor_id) DO UPDATE
         SET state = EXCLUDED.state, previous_state = EXCLUDED.previous_state, updated_at = EXCLUDED.updated_at
       WHERE review_states.updated_at < EXCLUDED.updated_at`,
      [workspaceId, idOf(from), idOf(to)],
    );
  },
});
