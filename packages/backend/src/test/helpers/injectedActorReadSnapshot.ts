// Mini-router suites inject ActorCtx to test node policy/projection rules; those
// identities intentionally have no actor/token rows. Keep that authentication
// seam explicit while retaining the REAL database snapshot and policy queries.
// Actor-row/token freshness must use the real boundary (actorSnapshot tests).
import { withReadSnapshot } from "../../db.js";
import { requireActor } from "../../spine/mutate.js";
import type { ActorCtx } from "../../types.js";

export function withActorReadSnapshot<T>(
  actor: ActorCtx | null,
  _workspaceId: string,
  read: (actor: ActorCtx) => Promise<T>,
): Promise<T> {
  return withReadSnapshot(() => read(requireActor(actor)));
}
