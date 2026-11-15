// THE site-settings contract — one object, one home. Adding a setting means:
// a field here + its default + its config-key mapping, plus wherever it's
// actually consumed (a Design-tab input / astro head / component). The old
// shape was ~14 parallel useStates whose every addition rippled through 11
// call sites (hook → deps → returns → BuilderApp destructure → settings
// object → onSettingsChange → two duplicated SiteSettings types → …).

import type { SiteConfig } from "./api";
import { resolveLocale } from "./i18n";

export type SiteSettings = {
  brand: string;
  tagline: string;
  /** Brand-logo image URL shown in the published nav ("" = text brand). */
  logo: string;
  nav: Array<{ label: string; nodeId: string }>;
  accent: string;
  locale: string;
  description: string;
  favicon: string;
  allowIndexing: boolean;
  analyticsProvider: string;
  analyticsId: string;
  /** In-UI custom domain (bare hostname). Persists in siteConfig and is
   *  emitted as a CNAME on every push, so the binding survives re-publishes.
   *  "" = no custom domain (use the *.github.io URL). */
  customDomain: string;
};

/** Initialise from bootstrap's site_config (workspace-config node attrs). */
/** The language a site speaks until its owner picks one: the account's own (Chinese accounts get 繁體中文, the rest English),
 *  so a site is not published in a language its owner never saw. */
export function accountSiteLocale(): "zh-TW" | "en" {
  return resolveLocale() === "en" ? "en" : "zh-TW";
}

export function siteSettingsFromConfig(cfg: SiteConfig | undefined | null): SiteSettings {
  const c = cfg ?? {};
  let nav: SiteSettings["nav"] = [];
  if (typeof c.nav === "string") {
    try { nav = JSON.parse(c.nav) as SiteSettings["nav"]; } catch { /* default */ }
  } else if (Array.isArray(c.nav)) {
    nav = c.nav as SiteSettings["nav"];
  }
  return {
    brand: (c.brand as string) ?? "Onden",
    tagline: (c.tagline as string) ?? "",
    logo: (c.logo as string) ?? "",
    nav,
    accent: (c.accent as string) ?? "#317563",
    locale: (c.locale as string) ?? accountSiteLocale(),
    description: (c.description as string) ?? "",
    favicon: (c.favicon as string) ?? "",
    allowIndexing: c.allow_indexing !== false,
    analyticsProvider: (c.analytics_provider as string) ?? "",
    analyticsId: (c.analytics_id as string) ?? "",
    customDomain: (c.custom_domain as string) ?? "",
  };
}

/** Serialise for PATCH /api/workspace/config (the attribute-key dialect). */
export function siteSettingsToConfig(s: SiteSettings): Record<string, unknown> {
  return {
    brand: s.brand,
    tagline: s.tagline,
    logo: s.logo,
    nav: JSON.stringify(s.nav),
    accent: s.accent,
    locale: s.locale,
    description: s.description,
    favicon: s.favicon,
    allow_indexing: s.allowIndexing,
    analytics_provider: s.analyticsProvider,
    analytics_id: s.analyticsId,
    custom_domain: s.customDomain,
  };
}

/** The presentation.site chunk of the publish request (the rest of the presentation is the server's). */
export function siteSettingsToManifestSite(s: SiteSettings): Record<string, unknown> {
  return { brand: s.brand, tagline: s.tagline, logo: s.logo, nav: s.nav, locale: s.locale };
}
