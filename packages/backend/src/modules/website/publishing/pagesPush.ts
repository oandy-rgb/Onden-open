// pages_push outbox effect: deploy the static copy of the site.
//
// Pushes the same files the zip download holds — the stored static copy
// (siteBundle.ts: every page as the SSR HTML the live site serves, plus its
// CSS, fonts, bundled media and search index) — to the configured external
// static host, with the host's address applied (retargetStaticSite). Runs from the outbox
// reconciler, so it is durable + retried; the small payload ({snapshotId}) is
// re-resolved at drain time, making it idempotent.

import { expectedPagesUrl, pushToGitHubPages, type BundleFile } from "./githubPages.js";
import { loadServedSite } from "./servedSite.js";
import { bundleFileSizes, readBundleFiles, ensureSiteBundle } from "./siteBundle.js";
import { retargetStaticSite } from "./staticSite.js";
import { cnameFile } from "./cname.js";
import { limitStaticVideos, oversizeVideoIds } from "./videoLimit.js";

export async function performPagesPush(payload: { snapshotId: string; workspaceId: string }): Promise<void> {
  // The same site every other surface serves (servedSite.loadServedSite): the
  // LATEST snapshot minus takedowns, read at drain time. One pending push per
  // workspace takes a burst of publishes and takedowns, so the push carries
  // whatever is current when it runs, not the snapshot that enqueued it.
  const site = await loadServedSite(payload.workspaceId);
  if (site.id == null) throw new Error(`pages_push: snapshot ${payload.snapshotId} not found`);

  // No external host configured: nothing to push (the stored copy is made by
  // the site_bundle effect either way).
  if (!expectedPagesUrl()) return;

  let files: BundleFile[];
  try {
    const bundle = await ensureSiteBundle({ workspaceId: payload.workspaceId });
    // A video over the static host's limit stays on the original site (videoLimit.ts).
    // The size is looked at before any file is read, so a big video never sits in memory.
    const tooBig = oversizeVideoIds(await bundleFileSizes(bundle));
    const readFiles = await readBundleFiles(bundle, (path) => path.startsWith("media/") && tooBig.has(path.slice(6)));
    files = limitStaticVideos(
      retargetStaticSite({ files: readFiles, facts: bundle.facts }, expectedPagesUrl()),
      bundle.facts.liveOrigin, tooBig,
    );
  } catch (e) {
    // The renderer being down is a deployment problem; the outbox retries
    // (and eventually buries the job) with this message.
    throw new Error(`pages_push: ${e instanceof Error ? e.message : String(e)} — check SITE_SSR_URL`);
  }

  // In-UI custom domain: emit a CNAME from the LIVE siteConfig so the binding
  // PERSISTS across pushes (the user sets it once, in-app, never in GitHub).
  // Absent/invalid → no CNAME file, so a configured domain is simply dropped.
  const cname = await cnameFile(payload.workspaceId);
  if (cname) files.push(cname);

  // null = no external host configured → no-op (consistent with the backup
  // effects); not a failure to retry.
  await pushToGitHubPages(files);
}
