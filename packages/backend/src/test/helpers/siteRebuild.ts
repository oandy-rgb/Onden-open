import { _armInstantDrainForTests, _disarmInstantDrainForTests } from "../../services/outbox.js";
import { siteRebuildEffect } from "../../modules/website/effects.js";

/** Run the website's site_rebuild intents of `workspace` as soon as their
 *  transaction commits, as the production reconciler does; every other effect
 *  (git, GitHub, embeddings, the pages push) is a no-op here — `onPagesPush`
 *  hears each pages push instead. Rows of other workspaces (other files in
 *  the shared test database) are left alone. Disarm in afterAll. */
export function armSiteRebuild(
  workspace: () => string, onPagesPush?: (payload: Record<string, unknown>) => void,
): void {
  _armInstantDrainForTests(async (kind, payload, signal) => {
    if (kind === "site_rebuild") await siteRebuildEffect.perform(siteRebuildEffect.parse(payload), signal);
    if (kind === "pages_push") onPagesPush?.(payload);
  }, workspace);
}

export const disarmSiteRebuild = _disarmInstantDrainForTests; // async: waits out passes still in flight
