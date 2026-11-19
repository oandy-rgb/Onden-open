import { Hono } from "hono";
import { z } from "zod";
import { isCalendarDay, isHexColor, daysBetween, EXTERNAL_CALENDAR_NAME_MAX } from "@onden/markdown";
import { getWorkspaceId } from "../../db.js";
import { requireActor } from "../../spine/mutate.js";
import { requirePerson } from "../../spine/authority.js";
import { secretKeyConfigured } from "../../services/aiCredentials.js";
import { CodedStatusError, StatusError } from "../../statusError.js";
import { parseBody, uuidParam } from "../../routes/params.js";
import type { ActorCtx } from "../../types.js";
import { parseCalendarUrl } from "./calendarUrl.js";
import { refreshByPerson, refreshCalendar } from "./refresh.js";
import { addCalendar, changeCalendar, eventsBetween, getCalendar, listCalendars, removeCalendar } from "./store.js";

// External calendars (read-only iCal subscriptions). Personal: every route answers
// only for the signed-in person's own calendars, and a calendar of someone else is
// a 404. An agent token never manages them: the address is a secret, and a
// subscription is not something an agent acts on.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

const MAX_EVENT_WINDOW_DAYS = 62;

function person(c: { get(key: "actor"): ActorCtx | null }): ActorCtx {
  const actor = requireActor(c.get("actor"));
  requirePerson(actor, "external_calendars");
  return actor;
}

const color = z.string().refine(isHexColor, "color");
const address = z.string().max(4000);
const name = z.string().trim().min(1).max(EXTERNAL_CALENDAR_NAME_MAX);

// GET /api/external-calendars → { available, calendars }. `available` is false on a
// server with no ONDEN_SECRET_KEY: the page then says why nothing can be added.
router.get("/", async (c) => {
  const actor = person(c);
  return c.json({ available: secretKeyConfigured(), calendars: await listCalendars(actor.id) });
});

// POST /api/external-calendars {id?, name, color, url} → 201. The address is never answered back.
router.post("/", async (c) => {
  const actor = person(c);
  const body = await parseBody(c, z.object({ id: z.string().uuid().optional(), name, color, url: address }));
  // The page says why before it offers the form (GET answers available:false); this is the fallback.
  if (!secretKeyConfigured()) throw new StatusError(409, "no secret key");
  const parsed = parseCalendarUrl(body.url);
  if (!parsed) throw new CodedStatusError(422, "invalid_url", "not a calendar address");
  const workspaceId = await getWorkspaceId();
  const id = body.id ?? crypto.randomUUID();
  const saved = await addCalendar(workspaceId, actor, { id, name: body.name, color: body.color, href: parsed.href, host: parsed.host });
  if (saved === "limit") throw new StatusError(409, "too many calendars");
  await refreshCalendar(workspaceId, id).catch(() => false);
  return c.json((await getCalendar(actor.id, id)) ?? saved, 201);
});

router.patch("/:id", async (c) => {
  const actor = person(c);
  const patch = await parseBody(c, z.object({ name: name.optional(), color: color.optional(), enabled: z.boolean().optional() }));
  const workspaceId = await getWorkspaceId();
  const saved = await changeCalendar(workspaceId, actor, uuidParam(c, "id"), patch);
  if (!saved) throw new StatusError(404, "calendar not found");
  // Switching one back on shows its events at once rather than at the next pass.
  if (patch.enabled === true) await refreshCalendar(workspaceId, saved.id).catch(() => false);
  return c.json((await getCalendar(actor.id, saved.id)) ?? saved);
});

router.delete("/:id", async (c) => {
  const actor = person(c);
  if (!(await removeCalendar(await getWorkspaceId(), actor, uuidParam(c, "id")))) throw new StatusError(404, "calendar not found");
  return c.json({ ok: true });
});

// POST /api/external-calendars/:id/refresh → the calendar after the fetch. One per minute per calendar.
router.post("/:id/refresh", async (c) => {
  const actor = person(c);
  const id = uuidParam(c, "id");
  if ((await refreshByPerson(await getWorkspaceId(), actor.id, id)) === "missing") throw new StatusError(404, "calendar not found");
  return c.json(await getCalendar(actor.id, id));
});

// GET /api/external-calendars/events?from=YYYY-MM-DD&to=YYYY-MM-DD → events touching those workspace days.
router.get("/events", async (c) => {
  const actor = person(c);
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!isCalendarDay(from) || !isCalendarDay(to) || to < from || daysBetween(from, to) > MAX_EVENT_WINDOW_DAYS) {
    throw new StatusError(400, "from and to must be days, at most 62 apart");
  }
  return c.json({ events: await eventsBetween(actor.id, from, to) });
});

export default router;
