// POST /api/publish/preview's answer (W38b, docs/architecture/site-render-model.md):
// the candidate a publish would store, what changes against the last publish,
// the links that will read "(private)", the media readers won't get, and the
// hash a publish sends back so only the previewed candidate goes out.
import type { PrecompiledDiagram } from "@onden/markdown";
import { ApiError } from "../../lib/api";
import type { PublishPreview } from "@onden/contract";

/** home_node_id: an explicit home override only; omitted, the server decides
 *  (the workspace's home, backend publishing/siteHome.ts). */
export type PublishBody = {
  title: string; home_node_id?: string | null; presentation: Record<string, unknown>;
  /** Flowcharts and state diagrams laid out in this browser (lib/diagramPrecompile.ts); the server checks each before keeping it. */
  diagrams?: PrecompiledDiagram[];
};
/** A publish waiting for confirmation: the body the preview was built from, and the preview. */
export type PendingPublish = { body: PublishBody; preview: PublishPreview };

/** The publish was refused because the site changed after the preview (409 preview_stale). */
export function isPreviewStale(error: unknown): boolean {
  for (let e = error; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof ApiError && e.code === "preview_stale") return true;
  }
  return false;
}

/** Anything readers will see change: the same reader view the hash covers
 *  (backend siteDiff), so "nothing changed" never meets a stale preview (D80). */
export const previewHasChanges = (p: PublishPreview) =>
  p.live === null || p.diff.settings_changed
  || [p.diff.added, p.diff.returning ?? [], p.diff.changed, p.diff.moved, p.diff.links_changed, p.diff.removed].some((list) => list.length > 0);
