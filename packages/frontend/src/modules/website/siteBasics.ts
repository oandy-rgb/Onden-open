// Rules behind Settings › Website (SiteBasicsSettings): which languages and
// analytics providers a site can take, the language a site starts with, and
// the custom-domain check. The stored values are the workspace-config keys
// lib/siteSettings maps (locale, description, allow_indexing,
// analytics_provider, analytics_id, custom_domain); the backend reads them in
// modules/website/publishing (publishedSet, htmlUtils, cname).

import { cleanCustomDomain, isCustomDomainHost } from "@onden/markdown";
import type { SiteConfig } from "../../lib/api";
import { accountSiteLocale } from "../../lib/siteSettings";

// Languages a published site can be in: SITE_LOCALES (@onden/markdown), the one list.
export { SITE_LOCALES } from "@onden/markdown";

/** Providers the published page can load (backend htmlUtils); "" = none. */
export const ANALYTICS_PROVIDERS = [
  { value: "plausible", label: "Plausible", idLabel: "Site domain", idPlaceholder: "example.com" },
  { value: "umami", label: "Umami", idLabel: "Website ID", idPlaceholder: "" },
  { value: "ga4", label: "Google Analytics", idLabel: "Measurement ID", idPlaceholder: "G-XXXXXXXXXX" },
] as const;

export function analyticsProviderOf(value: string) {
  return ANALYTICS_PROVIDERS.find((p) => p.value === value) ?? null;
}

/** The ID field only exists once a provider is chosen. */
export function showsAnalyticsId(provider: string): boolean {
  return analyticsProviderOf(provider) !== null;
}

/** The language shown for the site: the stored one, or — never set — the account's own
 *  (accountSiteLocale), which is also what the next publish sends (siteSettingsFromConfig). */
export function siteLocaleOf(config: SiteConfig | undefined | null): string {
  const stored = config?.locale;
  return typeof stored === "string" && stored ? stored : accountSiteLocale();
}

/** True when the site has no language of its own yet, so the first view stores the default. */
export function siteLocaleUnset(config: SiteConfig | undefined | null): boolean {
  return typeof config?.locale !== "string" || !config.locale;
}

/** A typed domain: "" clears it; a pasted address loses its https:// and path;
 *  anything that is not a plain host name is invalid (the server's rule, @onden/markdown). */
export function parseCustomDomain(raw: string): { ok: true; host: string } | { ok: false } {
  const host = cleanCustomDomain(raw);
  if (!host) return { ok: true, host: "" };
  return isCustomDomainHost(host) ? { ok: true, host } : { ok: false };
}
