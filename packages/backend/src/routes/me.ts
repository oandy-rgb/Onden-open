import { requireActor } from "../spine/mutate.js";
import { Hono } from "hono";
import type { ActorCtx } from "../types.js";
import { isPrefKey, isRetiredPrefKey, parsePref, readPref, writePref } from "../services/actorPrefs.js";
import { readJsonBody } from "./params.js";
import { StatusError } from "../statusError.js";
import { CLIENT_NOW_HEADER, MAX_EDIT_AGE_MS, editAgeMs as deviceEditAgeMs } from "../services/clientClock.js";

// The signed-in person's own things (services/actorPrefs.ts): preferences
// that follow them to every device. Each person sees only their own.
//
//   GET /api/me/prefs/:key  → { value }  (null when unset)
//   PUT /api/me/prefs/:key  { value, editAgeMs?, editedAt? }  (null clears it)
//                                          → { value, applied }
//     `editAgeMs` (how long before this request the edit was made, measured on
//     the device's own clock, so its offset from ours cancels out) makes the
//     write conditional: the server dates the edit on its logical clock minus
//     `editAgeMs` and a later stored edit stands; `value` is then what the
//     account holds with `applied: false`. `editedAt` (epoch ms, the device's
//     clock) is what older frontends send: it is never compared with anything
//     of ours, only turned into an age against the device's clock reading in
//     the `X-Onden-Client-Now` header (clientClock.ts), and ignored when
//     `editAgeMs` is also given. Without either the write is unconditional.
//
// An unknown key is 404; a value of the wrong shape is 400. A retired key
// (isRetiredPrefKey) is accepted and dropped, and reads as unset.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.get("/prefs/:key", async (c) => {
  const actor = requireActor(c.get("actor"));
  const key = c.req.param("key");
  if (isRetiredPrefKey(key)) return c.json({ value: null });
  if (!isPrefKey(key)) throw new StatusError(404, "unknown_pref");
  return c.json({ value: await readPref(actor, key) });
});

router.put("/prefs/:key", async (c) => {
  const actor = requireActor(c.get("actor"));
  const key = c.req.param("key");
  if (isRetiredPrefKey(key)) return c.json({ value: null, applied: true });
  if (!isPrefKey(key)) throw new StatusError(404, "unknown_pref");
  const body = await readJsonBody(c) as { value?: unknown; editedAt?: unknown; editAgeMs?: unknown } | undefined;
  const parsed = body && typeof body === "object" && "value" in body ? parsePref(key, body.value) : { ok: false as const };
  if (!parsed.ok) throw new StatusError(400, "invalid_pref");
  const editAgeMs = body?.editAgeMs;
  if (editAgeMs !== undefined && !(typeof editAgeMs === "number" && Number.isFinite(editAgeMs) && editAgeMs >= 0 && editAgeMs < MAX_EDIT_AGE_MS)) {
    throw new StatusError(400, "invalid_pref");
  }
  if (typeof editAgeMs === "number") {
    return c.json(await writePref(actor, key, parsed.value, editAgeMs));
  }
  const editedAt = body?.editedAt;
  if (editedAt !== undefined && !(typeof editedAt === "number" && Number.isFinite(editedAt) && editedAt > 0 && editedAt < 8.64e15)) {
    throw new StatusError(400, "invalid_pref");
  }
  const result = await writePref(actor, key, parsed.value, editedAt === undefined ? undefined : deviceEditAgeMs(c.req.header(CLIENT_NOW_HEADER), editedAt));
  return c.json(result);
});

export default router;
