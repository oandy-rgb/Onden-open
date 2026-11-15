// What the core asks of the published website without naming the module: whether
// the served site shows a media file (mediaAccess.canReadMedia's anonymous
// branch) and a note rendered as the site would (GET /api/nodes/:id/export.html).
// Filled by registerModuleEffects from ModuleDefinition.publicSite. The website
// is a feature module, so the core never imports it (test/importCycles.test.ts).

import type { ActorCtx } from "../types.js";

export type PublicSite = {
  /** Whether the served site shows `/api/media/<filename>` (`site`: judge that
   *  payload instead of the latest snapshot — the publish preview). */
  showsMedia: (workspaceId: string, filename: string, site?: Record<string, unknown>) => Promise<boolean>;
  /** One note as a self-contained themed HTML file; `exporter` evaluates its query blocks. */
  singleNoteExport: (workspaceId: string, note: { id: string; title: string; markdown: string }, exporter: ActorCtx) => Promise<string>;
};

let site: PublicSite | null = null;

export function registerPublicSite(impl: PublicSite): void {
  if (site && site !== impl) throw new Error("[modules] the public site is already provided by another module");
  site = impl;
}

/** The registered site; throws when no module provides one (a harness that
 *  mounts routers directly must call registerShippedModules). */
export function publicSite(): PublicSite {
  if (!site) throw new Error("[modules] no module provides the public site: register the website module first");
  return site;
}
