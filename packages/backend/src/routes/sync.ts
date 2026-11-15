import { isUuid } from "@onden/markdown";
import { Hono } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { parsePage } from "../services/paging.js";
import { StatusError } from "../statusError.js";
import { readJsonBody } from "./params.js";
import { buildSyncDelta, MEMBERSHIP_PAGE_SIZE, MEMBERSHIP_PAGE_MAX, membershipPage, membershipDigest, parseBucketPrefixes, nodesFor, bodiesFor, drawingIndex, drawingsFor, isDrawingsHeld, SyncRequestTooLarge } from "../services/sync/index.js";

// The sync protocol's HTTP surface. Each handler parses its request, calls
// services/sync (which owns the read snapshot, the read set and every rule
// about what a response may carry) and returns the result as JSON.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

const tooLarge = (e: SyncRequestTooLarge) => ({ error: "too_many_ids", limit: e.limit });

/** `ids` of a by-id read: every entry a UUID (isUuid), or null.
 *  A looser pattern let 36 dashes through to the `::uuid[]` cast (a 500). */
function uuidList(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string" && isUuid(x))) return null;
  return [...new Set(raw as string[])];
}
const badIds = { error: "bad_request", message: "ids must be UUIDs" };

// GET ?since= — the event delta with no held-id set (no membership diff).
router.get("/", async (c) => {
  const sinceRaw = c.req.query("since") ?? "0";
  const sinceParsed = parseInt(sinceRaw, 10);
  // Guard against NaN (e.g., ?since= with empty value) — defaults to 0.
  const since = Number.isFinite(sinceParsed) ? sinceParsed : 0;
  return c.json(await buildSyncDelta(c.get("actor"), await getWorkspaceId(), { since, known: [] }));
});

// POST {since, known} — the same delta; `known` (the ids the client holds)
// adds the one-shot membership diff.
router.post("/", async (c) => {
  const body = (await readJsonBody(c, { optional: true }) ?? {}) as { since?: unknown; known?: unknown };
  const sinceParsed = typeof body.since === "number" ? body.since : parseInt(String(body.since ?? "0"), 10);
  const since = Number.isFinite(sinceParsed) ? sinceParsed : 0;
  // LEGACY (Step C): the routine client no longer sends `known[]` — revocation +
  // grants now flow through GET /sync/membership + the epoch-gated client
  // reconcile (membership-and-permission-epoch.md). When omitted, `known` is []
  // and the diff is a no-op, so POST /sync is a pure event-delta pull. The
  // known[] diff is RETAINED as a capability (a caller MAY still pass it for a
  // one-shot full membership diff; exercised by syncRevocation.integration), but
  // it is no longer the live revocation path.
  const known = Array.isArray(body.known)
    ? body.known.filter((x): x is string => typeof x === "string")
    : [];
  return c.json(await buildSyncDelta(c.get("actor"), await getWorkspaceId(), { since, known }));
});

// GET /sync/membership — one page of the CURRENT readable-id stream (Step B).
router.get("/membership", async (c) => {
  const workspaceId = await getWorkspaceId();
  return c.json(await membershipPage(c.get("actor"), workspaceId, {
    cursor: c.req.query("cursor") ?? "",
    expectedEpoch: c.req.query("expected_epoch"),
    expectedEventCursor: c.req.query("expected_event_cursor"),
    // services/paging.ts: the one limit grammar (bad → 400); the page is a
    // keyset cursor over ids, not an offset.
    limit: parsePage({ limit: c.req.query("limit") }, { default: MEMBERSHIP_PAGE_SIZE, max: MEMBERSHIP_PAGE_MAX }).limit,
    // Only these id buckets (the digest's unequal ones); absent = every id.
    prefixes: parseBucketPrefixes(c.req.query("prefixes")),
  }));
});

// GET /sync/membership/digest — the readable set's digest, so a client whose
// set matches skips the pages (services/sync/membership.ts).
router.get("/membership/digest", async (c) => {
  const workspaceId = await getWorkspaceId();
  return c.json(await membershipDigest(c.get("actor"), workspaceId, {
    expectedEpoch: c.req.query("expected_epoch"),
    expectedEventCursor: c.req.query("expected_event_cursor"),
  }));
});

// POST /sync/bodies — note bodies for the offline copy.
router.post("/bodies", async (c) => {
  const workspaceId = await getWorkspaceId();
  const body = (await readJsonBody(c, { optional: true }) ?? {}) as { ids?: unknown };
  const ids = uuidList(body.ids);
  if (!ids) return c.json(badIds, 400);
  try {
    return c.json(await bodiesFor(c.get("actor"), workspaceId, ids));
  } catch (e) {
    if (e instanceof SyncRequestTooLarge) return c.json(tooLarge(e), 413);
    throw e;
  }
});

// GET /sync/drawings — which readable notes hold a drawing (ink_data,
// pdf_annotations) and its size; POST {ids} — their values, for the offline
// copy; {ids, have} sends a drawing the device already holds an older copy of
// as a patch (services/sync/drawings.ts).
router.get("/drawings", async (c) => c.json(await drawingIndex(c.get("actor"), await getWorkspaceId())));
router.post("/drawings", async (c) => {
  const workspaceId = await getWorkspaceId();
  const body = (await readJsonBody(c, { optional: true }) ?? {}) as { ids?: unknown; have?: unknown };
  const ids = uuidList(body.ids);
  if (!ids) return c.json(badIds, 400);
  // `have`: the copies the device holds, so a changed drawing comes as a patch.
  const have = body.have;
  if (have !== undefined && !isDrawingsHeld(have)) throw new StatusError(400, "invalid_have");
  try {
    return c.json(await drawingsFor(c.get("actor"), workspaceId, ids, have));
  } catch (e) {
    if (e instanceof SyncRequestTooLarge) return c.json(tooLarge(e), 413);
    throw e;
  }
});

// POST /sync/nodes — the full projection of ids the client found newly readable.
router.post("/nodes", async (c) => {
  const workspaceId = await getWorkspaceId();
  const body = (await readJsonBody(c, { optional: true }) ?? {}) as { ids?: unknown; expected_epoch?: unknown; expected_event_cursor?: unknown };
  // Not uuidList: its de-duplication would hide an oversized request (the 413 counts what was sent).
  const ids = body.ids === undefined ? [] : Array.isArray(body.ids) && body.ids.every((x) => typeof x === "string" && isUuid(x)) ? (body.ids as string[]) : null;
  if (!ids) return c.json(badIds, 400);
  try {
    return c.json(await nodesFor(c.get("actor"), workspaceId, ids, {
      expectedEpoch: body.expected_epoch, expectedEventCursor: body.expected_event_cursor,
    }));
  } catch (e) {
    if (e instanceof SyncRequestTooLarge) return c.json(tooLarge(e), 413);
    throw e;
  }
});

export default router;
