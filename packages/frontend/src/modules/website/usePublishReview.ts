// Every publish goes through the preview (W38b, model B: a snapshot is what
// readers get): start(body) shows what publishing `body` would put out,
// confirm() publishes exactly that candidate by its hash, and a site that
// changed in between is previewed again instead of published. Used by the
// Studio's Publish → and the timeline's Publish….
import { useRef, useState } from "react";
import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { t } from "../../lib/i18n";
import { precompileDiagrams } from "../../lib/diagramPrecompile";
import { siteSettingsToManifestSite, type SiteSettings } from "../../lib/siteSettings";
import type { makeWebsiteWriter } from "./websiteWriter";
import { isPreviewStale, type PendingPublish, type PublishBody } from "./publishPreview";

/** What the Studio and the timeline publish: the site's name and settings.
 *  The home design is not in the body: the server publishes the saved one (or
 *  its default). The home page is the server's decision too (backend
 *  publishing/siteHome.ts); a body names one only as an explicit override
 *  (`homeOverride`), never a client-side guess (D116). */
export function homePublishBody(settings: SiteSettings, homeOverride?: string | null): PublishBody {
  return {
    title: settings.brand || "Onden Site",
    ...(homeOverride ? { home_node_id: homeOverride } : {}),
    presentation: { site: siteSettingsToManifestSite(settings) },
  };
}

/** The sentence for the notes 「一起發布」 refused for one reason (the server's `failed[].error`). Unknown
 *  reasons get the plain sentence: a code is never shown. */
function includeFailureText(reason: string, n: number): string {
  if (reason === "hidden") return t("{n} notes could not be published together: they are hidden.", { n });
  if (reason === "space_not_published") return t("{n} notes could not be published together: their space does not publish.", { n });
  if (reason === "not_a_page") return t("{n} notes could not be published together: they are in the trash or no longer available.", { n });
  return t("{n} notes could not be published together.", { n });
}

/** After 「一起發布」: say plainly when some notes could not be published
 *  (the write itself succeeded for the rest), one sentence per reason the
 *  server gave. True when none failed. */
export function reportIncluded(result: { failed?: unknown[] } | { deduped: true }): boolean {
  const failed = "failed" in result && Array.isArray(result.failed) ? result.failed : [];
  if (failed.length === 0) return true;
  const perReason = new Map<string, number>();
  for (const f of failed) {
    const reason = typeof (f as { error?: unknown })?.error === "string" ? (f as { error: string }).error : "";
    // Reasons this screen does not know read the same, so they are one sentence.
    const key = ["hidden", "space_not_published", "not_a_page"].includes(reason) ? reason : "";
    perReason.set(key, (perReason.get(key) ?? 0) + 1);
  }
  addToast([...perReason].map(([reason, n]) => includeFailureText(reason, n)).join(" "), "error");
  return false;
}

type Writer = Pick<ReturnType<typeof makeWebsiteWriter>, "previewPublish" | "publish"> & Partial<Pick<ReturnType<typeof makeWebsiteWriter>, "includeNotes">>;

export function usePublishReview(writer: Writer) {
  const [pending, setPending] = useState<PendingPublish | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const busy = useRef(false);

  async function load(body: PublishBody) {
    setPending({ body, preview: await writer.previewPublish(body) });
  }

  /** Show the preview of publishing `body` (from `prepare`, which may save first). */
  async function start(prepare: () => Promise<PublishBody>): Promise<void> {
    if (busy.current) return;
    busy.current = true; setLoading(true);
    try { await load(await prepare()); }
    catch (error) { writeErrors.report(error, addToast); }
    finally { busy.current = false; setLoading(false); }
  }

  /** Publish the previewed candidate. Resolves the publish result, or null when
   *  it didn't go out (reported; on a stale preview the new one is showing). */
  async function confirm(): Promise<{ url: string } | null> {
    const current = pending;
    if (!current || busy.current) return null;
    busy.current = true; setPublishing(true);
    try {
      // Flowcharts are laid out here, in the browser that has mermaid, and only
      // their data goes up; what is not ready in time is drawn by the reader's browser.
      const diagrams = await precompileDiagrams(current.preview.diagrams_needed ?? []);
      const result = await writer.publish({ ...current.body, ...(diagrams.length > 0 ? { diagrams } : {}), preview_hash: current.preview.hash });
      setPending(null);
      return result;
    } catch (error) {
      // Reported by the writer. Stale: show what would go out now instead.
      if (isPreviewStale(error)) await load(current.body).catch((e) => { setPending(null); writeErrors.report(e, addToast); });
      return null;
    } finally { busy.current = false; setPublishing(false); }
  }

  /** 「一起發布」: publish these notes with the site, then show what would go out now.
   *  False when it did not go through (reported by the writer). */
  async function include(noteIds: string[]): Promise<boolean> {
    const current = pending;
    if (!current || !writer.includeNotes || busy.current) return false;
    busy.current = true; setLoading(true);
    try {
      let result;
      try { result = await writer.includeNotes(noteIds); } catch { return false; } // reported by the online write
      // The others are published now; a failed re-read must not look like a failed include.
      await load(current.body).catch((error) => writeErrors.report(error, addToast));
      return reportIncluded(result);
    } finally { busy.current = false; setLoading(false); }
  }

  /** Build the preview again for the same body: after the owner changed what
   *  the site includes from the dialog (moved a note to a publishing space). */
  async function refresh(): Promise<void> {
    const current = pending;
    if (!current || busy.current) return;
    busy.current = true; setLoading(true);
    try { await load(current.body); }
    catch (error) { writeErrors.report(error, addToast); }
    finally { busy.current = false; setLoading(false); }
  }

  return { pending, loading, publishing, start, confirm, include, refresh, cancel: () => setPending(null) };
}
