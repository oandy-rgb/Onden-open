import { isCalendarDay } from "@onden/markdown";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { localDayId } from "../localDay.js";
import {
  activityByDay, agentRunsOn, deletedNoteBody, feedByDay, noteAt, notesEditedOn, notesEditedPage, recentlyDeleted, redoAgentRun, rewindsOn, rewindWorkspace,
  undoAgentRun, undoRewind, workspaceAt, DELETED_PAGE_DEFAULT, FEED_NOTES_PER_DAY, isDeletedCursor, type DeletedWindow,
} from "../services/history/index.js";
import { parseCount } from "../services/paging.js";
import { purgeDeletedEach } from "../services/nodeTrash.js";
import { parseBody, parseQuery, uuidParam, uuidQuery } from "./params.js";
import { StatusError } from "../statusError.js";

type Env = { Variables: { actor: ActorCtx | null } };

const router = new Hono<Env>();

/** `?space=<space id>`: no filter when absent; anything but a uuid is a 400. */
function spaceParam(c: Context): { spaceId?: string } {
  const spaceId = uuidQuery(c, "space", { optional: true });
  return spaceId === undefined ? {} : { spaceId };
}

/** The `?days=&until=&space=` of a range read: the day count in [1, max], the last day (a real calendar
 *  day, default today on the workspace clock) and the space filter; a 400 response when one is wrong. */
function rangeParams(c: Context, fallbackDays: number, maxDays: number): { days: number; until: string; space: { spaceId?: string } } | Response {
  const days = parseCount(c.req.query("days"), { fallback: fallbackDays, max: maxDays });
  if (days === null) return c.json({ error: `days must be 1–${maxDays}` }, 400);
  const until = c.req.query("until") ?? localDayId();
  if (!isCalendarDay(until)) throw new StatusError(400, "until must be YYYY-MM-DD");
  const space = spaceParam(c);
  return { days, until, space };
}

// Whole-workspace History (docs/architecture/history-api.md): everything is
// limited to the notes the caller can read.
router.get("/activity", async (c) => {
  const range = rangeParams(c, 14, 90);
  if (range instanceof Response) return range;
  return c.json({ days: await activityByDay(requireActor(c.get("actor")), await getWorkspaceId(), range.days, range.until, range.space) });
});

// The days that have edits in [until-days+1, until], newest first — the same
// notes and runs as /day, many days in one read.
router.get("/feed", async (c) => {
  const range = rangeParams(c, 14, 31);
  if (range instanceof Response) return range;
  return c.json(await feedByDay(requireActor(c.get("actor")), await getWorkspaceId(), range.until, range.days, range.space));
});

/** `?date=` (default today) and `?space=` of the one-day reads; the error response when either is malformed. */
function dayAndSpace(c: Context<Env>): { date: string; space: { spaceId?: string } } | Response {
  const date = c.req.query("date") ?? localDayId();
  if (!isCalendarDay(date)) throw new StatusError(400, "date must be YYYY-MM-DD");
  return { date, space: spaceParam(c) };
}

router.get("/day", async (c) => {
  const query = dayAndSpace(c);
  if (query instanceof Response) return query;
  const { date, space } = query;
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  const [notes, agent_runs, rewinds] = await Promise.all([
    notesEditedOn(actor, workspaceId, date, space), agentRunsOn(actor, workspaceId, date, space), rewindsOn(actor, workspaceId, date, space),
  ]);
  return c.json({ notes, agent_runs, rewinds });
});

// One page of a day's notes (the feed sends the first FEED_NOTES_PER_DAY of each day).
router.get("/day/notes", async (c) => {
  const query = dayAndSpace(c);
  if (query instanceof Response) return query;
  const { date, space } = query;
  const offset = parseCount(c.req.query("offset"), { fallback: 0, min: 0, max: 100_000 });
  const limit = parseCount(c.req.query("limit"), { fallback: FEED_NOTES_PER_DAY, max: 200 });
  if (offset === null || limit === null) throw new StatusError(400, "offset must be 0–100000 and limit 1–200");
  return c.json(await notesEditedPage(requireActor(c.get("actor")), await getWorkspaceId(), date, { offset, limit }, space));
});

// 「最近刪除」: `?days=` is the first page (the last N days, all of them); `older_cursor`, when not null, is
// sent back as `?before=` (with `&limit=`) for the next, older page. Nothing is deleted by age.
const deletedQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  before: z.string().refine(isDeletedCursor, "not a cursor of this list").optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
router.get("/deleted", async (c) => {
  const space = spaceParam(c);
  const { days, before, limit } = parseQuery(c, deletedQuery);
  const window: DeletedWindow = before !== undefined ? { before, limit } : { days: days ?? 30 };
  return c.json(await recentlyDeleted(requireActor(c.get("actor")), await getWorkspaceId(), window, space));
});

// The last text of one deleted note (the preview beside the list). 404 for a note
// that is not deleted, is gone, or that the caller cannot read.
router.get("/deleted/:id", async (c) => {
  const id = uuidParam(c, "id");
  const space = spaceParam(c);
  const note = await deletedNoteBody(requireActor(c.get("actor")), await getWorkspaceId(), id, space);
  return note ? c.json(note) : c.json({ error: "not found" }, 404);
});

// 「全部永久刪除」: one purgeDeleted per item (docs/architecture/history-api.md),
// each answered on its own — a refused note does not stop the others.
const purgeBody = z.object({
  items: z.array(z.object({
    node_id: z.string().uuid(),
    expected_ids: z.array(z.string().uuid()).min(1).max(100_000),
  })).min(1).max(200),
});

router.post("/deleted/purge", async (c) => {
  const input = await parseBody(c, purgeBody, { optional: true });
  const results = await purgeDeletedEach(
    requireActor(c.get("actor")), await getWorkspaceId(),
    input.items.map((item) => ({ nodeId: item.node_id, expected: item.expected_ids })),
  );
  return c.json({ results });
});

// The notes as they were at an instant, against now (docs/architecture/history-api.md,
// 「看那時的樣子」). `t` is an ISO time with offset; a time in the future is now.
const atTime = z.string().datetime({ offset: true });
function timeParam(raw: string | undefined): Date | null {
  const parsed = atTime.safeParse(raw);
  if (!parsed.success) return null;
  return new Date(Math.min(Date.parse(parsed.data), Date.now()));
}
const T_400 = { error: "t must be an ISO time" };

router.get("/at", async (c) => {
  const at = timeParam(c.req.query("t"));
  if (!at) return c.json(T_400, 400);
  const space = spaceParam(c);
  return c.json(await workspaceAt(requireActor(c.get("actor")), await getWorkspaceId(), at, space));
});

router.get("/at/:id", async (c) => {
  const id = uuidParam(c, "id");
  const at = timeParam(c.req.query("t"));
  if (!at) return c.json(T_400, 400);
  const space = spaceParam(c);
  const note = await noteAt(requireActor(c.get("actor")), await getWorkspaceId(), id, at, space);
  return note ? c.json(note) : c.json({ error: "not found" }, 404);
});

// 「還原到這時」: the browser sends the three lists it showed; the server checks
// each id against the state at `t` and the caller's write rights (rewind.ts).
const idList = z.array(z.string().uuid()).max(5000);
const rewindBody = z.object({
  t: atTime,
  space: z.string().uuid().optional(),
  restore_ids: idList, undelete_ids: idList, delete_ids: idList,
});

router.post("/rewind", async (c) => {
  const input = await parseBody(c, rewindBody, { optional: true });
  const at = new Date(Math.min(Date.parse(input.t), Date.now()));
  return c.json(await rewindWorkspace(
    await getWorkspaceId(),
    { at, restoreIds: input.restore_ids, undeleteIds: input.undelete_ids, deleteIds: input.delete_ids },
    { actor: requireActor(c.get("actor")), spaceId: input.space },
  ));
});

router.post("/rewinds/:rewindId/undo", async (c) => {
  const input = await parseBody(c, revertBody, { optional: true });
  return c.json(await undoRewind(await getWorkspaceId(), c.req.param("rewindId"), input.node_ids, { actor: requireActor(c.get("actor")) }));
});

const revertBody = z.object({ node_ids: z.array(z.string().min(1).max(64)).max(500) });

router.post("/agent-runs/:runId/undo", async (c) => {
  const input = await parseBody(c, revertBody, { optional: true });
  return c.json(await undoAgentRun(await getWorkspaceId(), c.req.param("runId"), input.node_ids, { actor: requireActor(c.get("actor")) }));
});

router.post("/agent-runs/:runId/redo", async (c) => {
  const input = await parseBody(c, revertBody, { optional: true });
  return c.json(await redoAgentRun(await getWorkspaceId(), c.req.param("runId"), input.node_ids, { actor: requireActor(c.get("actor")) }));
});

export default router;
