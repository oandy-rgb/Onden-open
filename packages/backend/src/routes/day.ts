import { Hono } from "hono";
import { isCalendarDay } from "@onden/markdown";
import { getWorkspaceId } from "../services/workspaceId.js";
import { dayLens } from "../services/dayLens.js";
import type { ActorCtx } from "../types.js";
import { StatusError } from "../statusError.js";

// Day lens — the read-only, server-computed projection a day node also shows
// besides what the user wrote (services/dayLens.ts has the buckets and the
// read policy). This route validates the date and answers.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// GET /api/day/:date/lens  (date = YYYY-MM-DD)
router.get("/:date/lens", async (c) => {
  const date = c.req.param("date");
  // Postgres has no year 0000 and throws on 2026-02-31, so only a real calendar day goes on.
  if (!isCalendarDay(date)) {
    throw new StatusError(400, "date must be a valid calendar date: YYYY-MM-DD");
  }

  return c.json(await dayLens(c.get("actor"), await getWorkspaceId(), date));
});

export default router;
