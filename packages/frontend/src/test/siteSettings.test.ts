import { describe, it, expect } from "vitest";
import {
  siteSettingsFromConfig, siteSettingsToConfig,
  siteSettingsToManifestSite,
  type SiteSettings,
} from "../lib/siteSettings";
import type { SiteConfig } from "../lib/api";
import { accountSiteLocale } from "../lib/siteSettings";

// The one site-settings home: config (attr-key dialect) ↔ SiteSettings ↔
// manifest dialect. Pins defaults, the nav string/array tolerance, the
// allow_indexing default-on quirk, and a config→settings→config round-trip
// (adding a ⑩ field that breaks the mapping shows up here).

describe("siteSettingsFromConfig", () => {
  it("fills sensible defaults from an empty/missing config", () => {
    const s = siteSettingsFromConfig(undefined);
    expect(s.brand).toBe("Onden");
    expect(s.accent).toBe("#317563");
    expect(s.locale).toBe(accountSiteLocale()); // the account's language (siteBasics.test.ts checks both)
    expect(s.allowIndexing).toBe(true); // default-ON
    expect(s.nav).toEqual([]);
    expect(s.customDomain).toBe("");
  });

  it("parses nav from a JSON string", () => {
    const s = siteSettingsFromConfig({ nav: '[{"label":"Home","nodeId":"n1"}]' } as unknown as SiteConfig);
    expect(s.nav).toEqual([{ label: "Home", nodeId: "n1" }]);
  });

  it("accepts nav as an already-parsed array", () => {
    const s = siteSettingsFromConfig({ nav: [{ label: "Docs", nodeId: "n2" }] } as unknown as SiteConfig);
    expect(s.nav).toEqual([{ label: "Docs", nodeId: "n2" }]);
  });

  it("falls back to [] on malformed nav JSON", () => {
    const s = siteSettingsFromConfig({ nav: "{not json" } as unknown as SiteConfig);
    expect(s.nav).toEqual([]);
  });

  it("treats allow_indexing as ON unless explicitly false", () => {
    expect(siteSettingsFromConfig({ allow_indexing: false } as unknown as SiteConfig).allowIndexing).toBe(false);
    expect(siteSettingsFromConfig({ allow_indexing: true } as unknown as SiteConfig).allowIndexing).toBe(true);
    expect(siteSettingsFromConfig({} as SiteConfig).allowIndexing).toBe(true);
  });

  it("carries the logo through", () => {
    expect(siteSettingsFromConfig({ logo: "/logo.svg" } as unknown as SiteConfig).logo).toBe("/logo.svg");
  });
});

describe("siteSettingsToConfig", () => {
  it("serialises nav back to a JSON string and uses the attr-key dialect", () => {
    const s = siteSettingsFromConfig({ nav: [{ label: "A", nodeId: "1" }] } as unknown as SiteConfig);
    const cfg = siteSettingsToConfig(s);
    expect(cfg.nav).toBe('[{"label":"A","nodeId":"1"}]');
    expect(cfg.allow_indexing).toBe(true);
  });

  it("round-trips config → settings → config for the full field set", () => {
    const original = {
      brand: "Acme", tagline: "tag", logo: "/l.png",
      nav: '[{"label":"Home","nodeId":"h"}]',
      accent: "#aa0000", locale: "en", description: "desc",
      favicon: "/f.ico", allow_indexing: false,
      analytics_provider: "plausible", analytics_id: "abc",
      custom_domain: "blog.example.com",
    } as unknown as SiteConfig;
    expect(siteSettingsToConfig(siteSettingsFromConfig(original))).toEqual(original);
  });
});

describe("manifest projection", () => {
  const s: SiteSettings = siteSettingsFromConfig({
    brand: "Acme", tagline: "t", logo: "/l", locale: "en",
    nav: [{ label: "H", nodeId: "h" }],
  } as unknown as SiteConfig);

  it("manifest.site carries only the presentation identity chunk", () => {
    expect(siteSettingsToManifestSite(s)).toEqual({
      brand: "Acme", tagline: "t", logo: "/l", nav: [{ label: "H", nodeId: "h" }], locale: "en",
    });
  });
});
