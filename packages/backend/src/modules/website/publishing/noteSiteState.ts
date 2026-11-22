// Where one note stands on the published site, for the note's own Share menu:
// is it there, and would a publish change what readers see of it. Built from
// the same pieces as the publish preview (the latest snapshot, the candidate's
// frozen notes, siteDiff's reader view), for one note instead of the site.

import { storedNote } from "./latestSnapshot.js";
import { candidateNote } from "./snapshot.js";
import { noteViewChanged } from "./siteDiff.js";
import type { ActorCtx } from "../../../types.js";

export type NoteSiteState = "not_on_site" | "outdated" | "current";

/** `not_on_site`: readers can't open the note now (not in the served site:
 *  never published, marked after the last Publish, or taken down since — even if it qualifies again: it returns with the next Publish, takenDown.ts).
 *  `outdated`: it is there, and a publish would show them something different.
 *  `current`: the site has the note as a publish would make it. `actor`
 *  evaluates the note's query blocks, as the publish would. */
export async function noteSiteState(workspaceId: string, nodeId: string, actor: ActorCtx | null): Promise<NoteSiteState> {
  // On the site now means in the snapshot AND still published (candidateNote
  // is null for a note outside the published set).
  const stored = await storedNote(workspaceId, nodeId);
  if (!stored) return "not_on_site";
  const next = await candidateNote(workspaceId, nodeId, actor);
  if (!next) return "not_on_site";
  return noteViewChanged(stored, next) ? "outdated" : "current";
}
