import { Hono } from "hono";
import { z } from "zod";
import type { ActorCtx } from "../../types.js";
import type { ReviewRating } from "@onden/contract";
import type { CardTarget } from "./state.js";
import * as review from "./service.js";
import { noteIsCard, setNoteCard } from "./cards.js";
import { parseQuery, readJsonBody, uuidParam } from "../../routes/params.js";
import { StatusError } from "../../statusError.js";
import { isTest } from "../../config.js";

// /api/review — parses the request, calls the review service (service.ts,
// which owns enrolment, budgets, grading and settings) and answers. The
// service's ReviewError reaches the shared HTTP boundary as { error } with
// its status.
const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

/** Tests pin the clock with `now`; production ignores it. */
function effectiveNow(testNow: string | undefined): Date {
  if (isTest() && testNow) return new Date(testNow);
  return new Date();
}
const queueQuery = z.object({
  root: z.string().uuid().optional(), tag_id: z.string().uuid().optional(),
  // The cards no tag group covers (the 「沒有標籤」 group); one scope at a time.
  untagged: z.enum(["true"]).optional(),
  now: z.string().datetime().optional(),
}).refine(query => [query.root, query.tag_id, query.untagged].filter(Boolean).length <= 1, { message: "root, tag_id and untagged cannot be combined" });

router.get("/queue", async c => {
  const query = queueQuery.parse(c.req.query());
  return c.json(await review.queue(c.get("actor"), { root: query.root, tagId: query.tag_id, untagged: query.untagged === "true", now: effectiveNow(query.now) }));
});

// The groups to study by (tags, or notes) with what a session of each gives today.
router.get("/groups", async c => {
  const query = parseQuery(c, z.object({ by: z.enum(["tag", "note"]), now: z.string().datetime().optional() }));
  return c.json(await review.groups(c.get("actor"), { by: query.by, now: effectiveNow(query.now) }));
});

router.get("/decks", async c => {
  return c.json({ decks: await review.decks(c.get("actor"), effectiveNow(c.req.query("now"))) });
});

// The status page: today, overdue, the next seven days, often-forgotten cards.
router.get("/status", async c => {
  const query = parseQuery(c, z.object({ now: z.string().datetime().optional() }));
  return c.json(await review.status(c.get("actor"), { now: effectiveNow(query.now) }));
});

router.get("/stats", async c => {
  const query = z.object({ tag_id: z.string().uuid().optional(), now: z.string().datetime().optional() }).parse(c.req.query());
  return c.json(await review.stats(c.get("actor"), { tagId: query.tag_id, now: effectiveNow(query.now) }));
});

// Putting a card off ("tomorrow"), leaving it out (suspend) and bringing it
// back (resume): no grade, so the schedule is untouched.
async function holdNow(c: Parameters<typeof readJsonBody>[0]): Promise<Date> {
  const parsed = z.object({ now: z.string().datetime().optional() }).safeParse(await readJsonBody(c, { optional: true }));
  return effectiveNow(parsed.success ? parsed.data.now : undefined);
}

const gradeSchema = z.object({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  now: z.string().datetime().optional(),
  // The card's reps the client saw (0 = new). Absent: an older client, graded as stored.
  seen_reps: z.number().int().min(0).optional(),
});
const undoSchema = z.object({
  // The reps the grade being undone produced. Absent: an older client, undone as stored.
  graded_reps: z.number().int().min(1).optional(),
  // The grade (its grade_id) being undone: reps alone repeat after grade, undo, grade.
  graded_id: z.string().uuid().optional(),
});
async function undoBody(c: Parameters<typeof readJsonBody>[0]): Promise<{ id?: string; reps?: number }> {
  const parsed = undoSchema.safeParse(await readJsonBody(c, { optional: true }) ?? {});
  if (!parsed.success) throw new StatusError(400, "graded_reps must be a whole number and graded_id an id");
  return { id: parsed.data.graded_id, reps: parsed.data.graded_reps };
}

// Block cards (block-nodes.md B3): the same three, keyed by the block node.
/** The three no-grade changes ("tomorrow", stop, resume) on one kind of card's routes. */
function holdRoutes(prefix: string, param: "blockId" | "nodeId", target: (id: string) => CardTarget): void {
  router.post(`${prefix}/tomorrow`, async c => c.json(await review.putOffUntilTomorrow(c.get("actor"), target(uuidParam(c, param)), await holdNow(c))));
  router.post(`${prefix}/suspend`, async c => c.json(await review.stopReviewing(c.get("actor"), target(uuidParam(c, param)))));
  router.post(`${prefix}/resume`, async c => c.json(await review.resumeReviewing(c.get("actor"), target(uuidParam(c, param)))));
}
holdRoutes("/blocks/:blockId", "blockId", id => ({ kind: "block", id }));
holdRoutes("/:nodeId", "nodeId", id => ({ kind: "node", id }));

router.post("/blocks/:blockId/grade", async c => {
  const blockId = uuidParam(c, "blockId");
  const parsed = gradeSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new StatusError(400, "rating must be 1 (again), 2 (hard), 3 (good) or 4 (easy)");
  return c.json(await review.grade(c.get("actor"), blockId, parsed.data.rating as ReviewRating, effectiveNow(parsed.data.now), { kind: "block", id: blockId }, parsed.data.seen_reps));
});

router.get("/blocks/:blockId/state", async c => {
  const blockId = uuidParam(c, "blockId");
  return c.json({ block_id: blockId, ...(await review.cardState(c.get("actor"), blockId, { kind: "block", id: blockId })) });
});

router.post("/blocks/:blockId/undo-grade", async c => {
  const blockId = uuidParam(c, "blockId");
  return c.json(await review.undoGrade(c.get("actor"), blockId, { kind: "block", id: blockId }, await undoBody(c)));
});

// Whether a note is a card, and making it one or not (its own function reference; cards.ts).
router.get("/cards/:nodeId", async c => {
  const nodeId = uuidParam(c, "nodeId");
  return c.json({ node_id: nodeId, card: await noteIsCard(c.get("actor"), nodeId) });
});
router.put("/cards/:nodeId", async c => c.json(await setNoteCard(c.get("actor"), uuidParam(c, "nodeId"), true)));
router.delete("/cards/:nodeId", async c => c.json(await setNoteCard(c.get("actor"), uuidParam(c, "nodeId"), false)));

router.post("/:nodeId/grade", async c => {
  const nodeId = uuidParam(c, "nodeId");
  const parsed = gradeSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new StatusError(400, "rating must be 1 (again), 2 (hard), 3 (good) or 4 (easy)");
  return c.json(await review.grade(c.get("actor"), nodeId, parsed.data.rating as ReviewRating, effectiveNow(parsed.data.now), undefined, parsed.data.seen_reps));
});

// GET /api/review/:nodeId/state — the caller's own schedule for a card
// (null when they have not graded it). Read-gated like the note.
router.get("/:nodeId/state", async c => {
  const nodeId = uuidParam(c, "nodeId");
  return c.json({ node_id: nodeId, ...(await review.cardState(c.get("actor"), nodeId)) });
});

// The cards this person stopped inside a note (the note, its paragraphs, what is under it).
router.get("/:nodeId/stopped", async c => c.json({ stopped: await review.stoppedUnder(c.get("actor"), uuidParam(c, "nodeId")) }));

router.post("/:nodeId/undo-grade", async c => {
  const nodeId = uuidParam(c, "nodeId");
  return c.json(await review.undoGrade(c.get("actor"), nodeId, undefined, await undoBody(c)));
});

// Personal review settings for one source tag: GET reads, PUT replaces the
// whole set, PATCH merges (a field sent replaces it, null removes it, a field
// not sent is kept — a form owning one field must not use PUT), DELETE clears.
router.get("/settings/:tagId", async c => {
  const tagId = uuidParam(c, "tagId");
  return c.json({ mine: await review.personalSettings(c.get("actor"), tagId) });
});

router.put("/settings/:tagId", async c => {
  const tagId = uuidParam(c, "tagId");
  const parsed = review.settingsSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) return c.json({ error: review.SETTINGS_RANGE_MESSAGE }, 400);
  return c.json({ mine: await review.replaceSettings(c.get("actor"), tagId, parsed.data) });
});

router.patch("/settings/:tagId", async c => {
  const tagId = uuidParam(c, "tagId");
  const parsed = review.settingsPatchSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) return c.json({ error: review.SETTINGS_RANGE_MESSAGE }, 400);
  return c.json({ mine: await review.patchSettings(c.get("actor"), tagId, parsed.data) });
});

router.delete("/settings/:tagId", async c => {
  const tagId = uuidParam(c, "tagId");
  await review.clearSettings(c.get("actor"), tagId);
  return c.json({ mine: null });
});

export default router;
