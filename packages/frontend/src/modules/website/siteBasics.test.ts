import { afterEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../../lib/i18n";
import { ANALYTICS_PROVIDERS, SITE_LOCALES, parseCustomDomain, showsAnalyticsId, siteLocaleOf, siteLocaleUnset } from "./siteBasics";
import { siteSettingsFromConfig, siteSettingsToConfig } from "../../lib/siteSettings";

describe("site basics", () => {
  it("offers the app's languages", () => {
    expect(SITE_LOCALES.map((l) => l.value)).toEqual(["zh-TW", "en", "ja"]);
  });

  afterEach(() => setLocalePref("system"));

  it("a site with no language of its own speaks the account's: 繁體中文 for a Chinese account, English otherwise", () => {
    setLocalePref("zh-TW");
    expect(siteLocaleOf({})).toBe("zh-TW");
    expect(siteLocaleOf(undefined)).toBe("zh-TW");
    expect(siteSettingsFromConfig({}).locale).toBe("zh-TW");
    setLocalePref("en");
    expect(siteLocaleOf({})).toBe("en");
    expect(siteSettingsFromConfig({}).locale).toBe("en");
    expect(siteSettingsFromConfig({ locale: "ja" }).locale).toBe("ja");
  });

  it("marks a site with no stored language as unset", () => {
    expect(siteLocaleUnset({})).toBe(true);
    expect(siteLocaleUnset({ locale: "" })).toBe(true);
  });

  it("keeps a language that was set", () => {
    expect(siteLocaleOf({ locale: "en" })).toBe("en");
    expect(siteLocaleUnset({ locale: "en" })).toBe(false);
  });

  it("shows the analytics ID field only once a provider is chosen", () => {
    expect(showsAnalyticsId("")).toBe(false);
    expect(showsAnalyticsId("nonsense")).toBe(false);
    for (const p of ANALYTICS_PROVIDERS) expect(showsAnalyticsId(p.value)).toBe(true);
  });

  it("accepts plain host names and tidies pasted addresses", () => {
    expect(parseCustomDomain("")).toEqual({ ok: true, host: "" });
    expect(parseCustomDomain("  ")).toEqual({ ok: true, host: "" });
    expect(parseCustomDomain("www.Example.com")).toEqual({ ok: true, host: "www.example.com" });
    expect(parseCustomDomain("https://blog.example.com/about")).toEqual({ ok: true, host: "blog.example.com" });
  });

  it("rejects what is not a host name", () => {
    for (const bad of ["example", "exa mple.com", "example.com:8080", "-a.example.com", "a..com", "例子.com"]) {
      expect(parseCustomDomain(bad)).toEqual({ ok: false });
    }
  });

  it("reads and writes each setting under its own config key", () => {
    const s = siteSettingsFromConfig({
      locale: "en", description: "About", allow_indexing: false,
      analytics_provider: "ga4", analytics_id: "G-1", custom_domain: "a.example.com",
    });
    expect(s).toMatchObject({
      locale: "en", description: "About", allowIndexing: false,
      analyticsProvider: "ga4", analyticsId: "G-1", customDomain: "a.example.com",
    });
    expect(siteSettingsToConfig(s)).toMatchObject({
      locale: "en", description: "About", allow_indexing: false,
      analytics_provider: "ga4", analytics_id: "G-1", custom_domain: "a.example.com",
    });
    expect(siteSettingsFromConfig({}).allowIndexing).toBe(true);
  });
});
