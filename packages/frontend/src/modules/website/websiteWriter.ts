import { hasApiErrorCode, type SiteConfig } from "../../lib/api";
import type { PublishPreview } from "@onden/contract";
import type { PublishBody } from "./publishPreview";
import { t } from "../../lib/i18n";
import { reads, writersFor, type WriterOptions } from "../../lib/data";
import { getAppState } from "../../lib/appStore";
import { randomUUID } from "../../lib/uuid";
import { validateDesign, type SiteDesign, type SiteDesignV2 } from "@onden/site";
import { designForSave } from "./studio/designModel";

/** The revision of a chrome (`rev`, stored by the server), or null for none. */
export function chromeRevision(chrome: Record<string, unknown> | null | undefined): string | null {
  return typeof chrome?.rev === "string" && chrome.rev ? chrome.rev : null;
}

/** A save refused because the design changed elsewhere since this tab loaded it. */
export function isDesignStale(error: unknown): boolean {
  return hasApiErrorCode(error, "design_stale");
}

/** POST /api/publish/include's answer. */
export type IncludeResult = { published: string[]; failed: Array<{ noteId: string; error: string }> };

export function makeWebsiteWriter(options: WriterOptions = {}) {
  const writers = writersFor(options);
  const workspace = writers.workspace;
  const onlineWrite = writers.online;
  const data = () => getAppState().data;
  return {
    saveSettings: (config: SiteConfig, options: { keepalive?: boolean } = {}) => workspace.saveDesign({ config }, options),
    /** Save the home studio's design. What is sent is the stored v3 design with the studio's changes laid over it (designForSave). What is sent is the design after
     *  validateDesignV2, never the raw editor state; it replaces the stored chrome
     *  whole. It names the chrome revision it started from and a new one of its
     *  own (the next save's base, even before this one is answered); a tab that
     *  missed a newer save elsewhere is refused (409 design_stale) instead of
     *  replacing that design with its copy (D119). */
    saveHomeDesign: (design: SiteDesignV2, options: { keepalive?: boolean } = {}) => {
      const current = data().chrome;
      return workspace.saveDesign({
        chrome: { ...designForSave(current, design), rev: randomUUID() },
        chromeBase: chromeRevision(current),
      }, options);
    },
    /** Save the website screen's design (v3: boxes, style, css). Same rules as the home studio's save:
     *  cleaned by validateDesign, a new `rev`, the revision it started from, refused as design_stale
     *  when another tab or device saved since. */
    saveSiteDesign: (design: SiteDesign, options: { keepalive?: boolean } = {}) =>
      workspace.saveDesign({
        chrome: { ...validateDesign(design).design, rev: randomUUID() },
        chromeBase: chromeRevision(data().chrome),
      }, options),
    /** 「一起發布」: mark these notes published (owner only, online). A note the
     *  owner may not publish (its space does not publish) is in `failed`; the
     *  others are published. */
    includeNotes: (noteIds: string[]) =>
      onlineWrite<IncludeResult>(`workspace:${data().workspace.id}:publish-include`, "/api/publish/include", JSON.stringify({ noteIds }), t("Publishing needs a connection.")),
    /** 「一起不發布」: keep the note and every live note under it off the site in
     *  one action (one undo on the server). Owner only, online. Throws when
     *  refused or not sent (reported by the online write); the local copy of the
     *  notes' flags arrives with sync. */
    keepSubtreeOff: (noteId: string) =>
      onlineWrite<{ marked: number; event_id: string }>(`node:${noteId}:site-keep-off-subtree`, "/api/publish/keep-off-subtree", JSON.stringify({ noteId }), t("Keeping these notes off the site needs a connection.")),
    /** The server's current design, replacing this device's (after design_stale). */
    reloadDesign: () => workspace.reloadDesign(),
    /** What publishing `input` would put on the site (read-only). */
    previewPublish: (input: PublishBody) =>
      reads.modules.website.publishPreview<PublishPreview>({ ...input, home_node_id: input.home_node_id ?? undefined }),
    /** Publish exactly the previewed candidate: a changed site answers 409 preview_stale. */
    publish: (input: PublishBody & { preview_hash: string }) =>
      onlineWrite<{ url: string }>(`workspace:${data().workspace.id}`, "/api/publish", JSON.stringify({ ...input, home_node_id: input.home_node_id ?? undefined }), t("Publishing needs a connection.")),
  };
}
