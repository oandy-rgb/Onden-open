import { Hono } from "hono";
import { attachmentHeaders } from "../downloadHeaders.js";
import { requireActor } from "../spine/mutate.js";
import { getWorkspaceId } from "../services/workspaceId.js";
import { FRESH_PROOF_HEADER } from "../services/freshProof.js";
import { exportSnapshotStream, importSnapshotStream, snapshotReadiness, stopWaitingForSnapshotHistory } from "../services/stampedSnapshotStream.js";
import type { ActorCtx } from "../types.js";

// /api/snapshot: copy the workspace to an empty database with every row's write stamp kept (services/stampedSnapshot.ts and
// services/stampedJoin.ts; docs/architecture/proposals/add-device-snapshot-2026-11-15.md). Owner only; a thin call each.
// GET streams the snapshot out as lines of JSON; it needs a ticket from a fresh confirmation in the X-Onden-Fresh-Proof header (POST /api/fresh-proof,
// services/freshProof.ts), spent by this request, so a request that only holds the owner's session gets nothing. POST takes the same lines into this
// database's empty workspace and answers when it is complete (the two digests agree) or refuses and leaves the empty database. GET /readiness
// says, changing nothing, whether POST would be accepted now and what it would delete. POST /history/stop: the owner stops waiting for the earlier versions
// of a file whose notes came in (services/stampedSnapshotStream.ts stopWaitingForSnapshotHistory).
//
// THE LINES: every line starts with `{"kind":` (the stream's own `line()` writes it first and a test fails if one does not), so a reader may tell a line's
// kind from its first bytes. The first line, the hello, names the data shape of the pages (spine/syncDataShape.ts); another one is refused.
//
// A DEVICE THAT JOINED, OR A SERVER THAT TOOK OTHER DEVICES' BUNDLES, MAKES A FILE TOO: the hello names the other origins it holds and how far (`brought`). GET answers 409
// before it spends the ticket when this node cannot vouch for every stamp it holds (services/stampedSnapshot.ts snapshotSourceNode: `snapshot_source_joining`,
// `snapshot_foreign_origin`, `snapshot_source_unsettled`, `snapshot_too_many_origins`).

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.get("/readiness", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await snapshotReadiness(c.get("actor")));
});

router.get("/", async (c) => {
  const stream = await exportSnapshotStream(requireActor(c.get("actor")), await getWorkspaceId(), c.req.header(FRESH_PROOF_HEADER));
  return new Response(stream, { headers: { ...attachmentHeaders("onden-snapshot.ndjson", "application/x-ndjson"), "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
});

router.post("/", async (c) => {
  return c.json(await importSnapshotStream(requireActor(c.get("actor")), c.req.raw.body));
});

// The notes came, their earlier versions did not all come: the owner stops waiting for them (what had arrived of them goes; the notes stay).
router.post("/history/stop", async (c) => {
  return c.json(await stopWaitingForSnapshotHistory(requireActor(c.get("actor")), await getWorkspaceId()));
});

export default router;
