// In-UI custom-domain (CNAME) support that PERSISTS across pushes.
//
// GitHub Pages reads an apex `CNAME` file to bind a custom domain; without it,
// every push would drop the domain and the user would have to re-set it in the
// GitHub UI. By emitting the file from the LIVE siteConfig `custom_domain`
// value on every pages-push, the domain survives re-publishes — the user
// configures it once, in-app, and never touches GitHub.
//
// Reading live config (not the frozen snapshot) is deliberate: changing the
// domain takes effect on the next push without a content republish.

import { cleanCustomDomain, isCustomDomainHost } from "@onden/markdown";
import { getSiteConfig } from "../../../services/siteConfig.js";
import { expectedPagesUrl } from "./githubPages.js";

// Only a bare hostname (apex or sub-domain) is written: a malformed value
// would silently break the binding. A pasted URL is tolerated (scheme and path stripped).
export function normalizeCustomDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = cleanCustomDomain(raw);
  return host && isCustomDomainHost(host) ? host : null;
}

/** The CNAME file to add to the pages-push bundle, or null when no valid
 *  custom domain is configured. */
export async function cnameFile(
  workspaceId: string,
): Promise<{ path: string; content: string } | null> {
  const cfg = await getSiteConfig(workspaceId);
  const host = normalizeCustomDomain(cfg.custom_domain);
  return host ? { path: "CNAME", content: `${host}\n` } : null;
}

/** The address the static copy is served at: the custom domain once one is
 *  set (the CNAME this push writes makes GitHub answer there), else the
 *  github.io address; null when no external host is configured. What the
 *  copy's canonical links, sitemap, feed and the publish log's link carry. */
export async function staticSiteUrl(workspaceId: string): Promise<string | null> {
  const pages = expectedPagesUrl();
  if (!pages) return null;
  const host = normalizeCustomDomain((await getSiteConfig(workspaceId)).custom_domain);
  return host ? `https://${host}/` : pages;
}
