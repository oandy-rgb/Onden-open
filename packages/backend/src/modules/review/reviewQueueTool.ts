import { z } from "zod";
import type { AgentTool } from "../../services/agentTools/index.js";
import { deck, queue } from "./service.js";

// ⑥ agent 解題 — the read-only actuator seam that lets an agent pull the
// study queue and then work solutions with the EXISTING write tools
// (updateNode / createNode). Deliberately read-only: an agent grading its own
// cards is meaningless (the schedule models a HUMAN's memory), so there is no
// agent grade tool — the human grades, the agent only assists by answering.
//
// One queue: by default the tool answers the review service's queue(), the
// very cards GET /api/review/queue shows — due cards most-overdue first, then
// new cards in enrolment order, all within the person's one daily cap.
//
// Read-policy iron law: the service reads through readableScopeSql under the
// current actor, the same as every HTTP review read — a tag-scoped
// token sees only the #review cards inside its grant, never an out-of-scope
// card (no existence oracle). [[agent-capability-surface]]: a module
// registering a tool widens what agents can do; this one is a conscious,
// low-risk (read-only, scope-bounded) widening, exactly the future the module
// header anticipated.

const Args = z.object({
  // Cap how many cards come back (the agent works them in batches); `total`
  // still counts them all. Default: the app's queue page (100).
  limit: z.number().int().min(1).max(100).optional(),
  // When false, return ALL enrolled #review cards (not just the due ones) —
  // useful for an agent pre-answering a freshly-built deck.
  due_only: z.boolean().optional(),
  // Limit to one group, the same three the review page practises by (one at a
  // time): the cards in a note's subtree, the cards of a tag, or the cards no
  // tag group covers.
  root: z.string().uuid().optional(),
  tag_id: z.string().uuid().optional(),
  untagged: z.boolean().optional(),
}).refine(args => [args.root, args.tag_id, args.untagged].filter(Boolean).length <= 1, { message: "root, tag_id and untagged cannot be combined" });

export type ReviewQueueCard = {
  node_id: string;
  title: string;
  markdown: string;
  reps: number;
  due: string | null;
  answered: boolean;
};
export type ReviewQueueResult = { cards: ReviewQueueCard[]; total: number };

export const reviewQueueTool: AgentTool<z.infer<typeof Args>, ReviewQueueResult> = {
  name: "reviewQueue",
  access: "read",
  description:
    "List notes enrolled by a tag with the review module enabled that the calling actor may read. " +
    "By default returns the study queue the app shows: cards due now, most-overdue first, " +
    "then new cards within each tag's daily new-card limit; pass due_only:false " +
    "for the whole enrolled deck. root / tag_id / untagged limit it to one group, as the review page's 「練這組」 does. Read-only — use updateNode to write a worked " +
    "solution onto a card. The agent never grades (grading models human memory).",
  inputSchema: Args,
  async handler(args, { actor }) {
    const scope = { root: args.root, tagId: args.tag_id, untagged: args.untagged };
    const { cards, total } = args.due_only === false ? wholeDeck(await deck(actor, scope), args.limit)
      : await queue(actor, { cap: args.limit, ...scope });
    return {
      cards: cards.map((c) => ({
        node_id: c.node_id,
        title: c.title,
        markdown: c.markdown,
        reps: c.state?.reps ?? 0,
        due: c.state?.due ?? null,
        answered: c.state !== null,
      })),
      total,
    };
  },
};

/** The whole deck, earliest due first (never-graded cards, due null, first). */
function wholeDeck(cards: Awaited<ReturnType<typeof deck>>, limit: number | undefined) {
  const sorted = [...cards].sort((a, b) => (a.state?.due ?? "").localeCompare(b.state?.due ?? ""));
  return { cards: limit ? sorted.slice(0, limit) : sorted, total: sorted.length };
}
