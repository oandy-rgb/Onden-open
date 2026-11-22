// Reading a change bundle as an actor (the spine half is spine/stampedBundle.ts, which holds the format and the cut). The same operator rule as the snapshot's export
// (services/stampedSnapshot.ts): a person, the owner of the workspace, in ONE read snapshot in which the actor's authority is read again; the rows the bundle carries are the rows the
// owner's snapshot carries (`snapshotScopeFor`), so a node that was joined by snapshot is never sent a row its snapshot left out, and the deleted spaces the owner is a
// member of with what is in them (`bundleScopeFor`): their deletion must reach a node that holds them. A limited reader's bundle (per-space scopes) is not
// done: it needs the per-scope `have` and the tombstone cut of docs/research/sync-design-vs-literature-2026-11-16.md, "做「同步哪些空間」之前".
import { CodedStatusError } from "../statusError.js";
import { isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { readBundlePages, type Have } from "../spine/stampedBundle.js";
import type { ChangeBundlePage } from "../spine/snapshotSql.js";
import type { ActorCtx } from "../types.js";
import { withActorReadSnapshot } from "./actorReadSnapshot.js";
import { bundleScopeFor } from "./readPolicy.js";
// The receiving half needs what follows from received rows: loading the bundle's service fills spine/receivedDerivation.ts (applyChangeBundle refuses without it).
import "./receivedDerivation.js";

class BundleOwnerOnly extends CodedStatusError {
  constructor() { super(403, "bundle_owner_only", "only the owner of the workspace reads a change bundle (a bundle for a limited reader is not done)"); }
}

/** The pages of the bundle of what `have` lacks, as `authenticated` may read it. See spine/stampedBundle.ts for what a bundle says. */
export async function readChangeBundle(authenticated: ActorCtx, workspaceId: string, have: Have, options: { pageBytes?: number; afterCut?: () => Promise<void> } = {}): Promise<ChangeBundlePage[]> {
  requirePerson(authenticated, "read a change bundle");
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    if (!(await isWorkspaceOwner(actor))) throw new BundleOwnerOnly();
    return readBundlePages(workspaceId, have, await bundleScopeFor(actor), options);
  });
}
