import { Hono } from "hono";
import { attachmentHeaders } from "../downloadHeaders.js";
import { requireActor } from "../spine/mutate.js";
import { getWorkspaceId } from "../services/workspaceId.js";
import { exportSnapshotStream, importSnapshotStream } from "../services/stampedSnapshotStream.js";
import type { ActorCtx } from "../types.js";

// /api/snapshot: copy the workspace to an empty database with every row's write stamp kept (services/stampedSnapshot.ts and
// services/stampedJoin.ts; docs/architecture/proposals/add-device-snapshot-2026-11-15.md). Owner only; a thin call each.
// GET streams the snapshot out as lines of JSON; POST takes the same lines into this database's empty workspace and answers when it
// is complete (the two digests agree) or refuses and leaves the empty database.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.get("/", async (c) => {
  const stream = await exportSnapshotStream(requireActor(c.get("actor")), await getWorkspaceId());
  return new Response(stream, { headers: { ...attachmentHeaders("onden-snapshot.ndjson", "application/x-ndjson"), "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
});

router.post("/", async (c) => {
  return c.json(await importSnapshotStream(requireActor(c.get("actor")), c.req.raw.body));
});

export default router;
