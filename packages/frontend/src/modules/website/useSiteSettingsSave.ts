// The site's name and settings (brand, tagline, nav, SEO…): the stored config
// plus the edits this device has made, saved by autosave as the keys that
// changed. Used by the home studio.
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { Bootstrap, SiteConfig } from "../../lib/api";
import type { createAutosave } from "../../lib/data";
import { siteSettingsFromConfig, siteSettingsToConfig, type SiteSettings } from "../../lib/siteSettings";
import type { makeWebsiteWriter } from "./websiteWriter";

export function useSiteSettingsSave(
  data: Pick<Bootstrap, "site_config">,
  writer: Pick<ReturnType<typeof makeWebsiteWriter>, "saveSettings">,
  autosave: ReturnType<typeof createAutosave>,
) {
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(() => siteSettingsFromConfig(data.site_config));
  const settingsRef = useRef(siteSettings);
  const settingsChanges = useRef<SiteConfig>({});
  const updateSiteSettings = useCallback((value: SetStateAction<SiteSettings>) => {
    const next = typeof value === "function" ? value(settingsRef.current) : value;
    if (JSON.stringify(next) === JSON.stringify(settingsRef.current)) return;
    const beforeConfig = siteSettingsToConfig(settingsRef.current);
    const nextConfig = siteSettingsToConfig(next);
    const changes = { ...settingsChanges.current };
    for (const key of Object.keys(nextConfig)) {
      if (JSON.stringify(beforeConfig[key]) !== JSON.stringify(nextConfig[key])) changes[key] = nextConfig[key];
    }
    settingsChanges.current = changes;
    settingsRef.current = next; setSiteSettings(next);
    // Once a save settles (accepted, queued, or refused and rolled back by the
    // writer), its keys stop overriding the stored config — unless edited
    // again meanwhile. They used to stay forever: another device's newer value
    // never showed and every later save re-sent them (GAP-243).
    const settle = () => {
      const left = { ...settingsChanges.current };
      for (const key of Object.keys(changes)) {
        if (JSON.stringify(left[key]) === JSON.stringify(changes[key])) delete left[key];
      }
      settingsChanges.current = left;
    };
    autosave.schedule("settings", (options) => {
      const saving = writer.saveSettings(changes, options);
      void Promise.resolve(saving).then(settle, settle);
      return saving;
    });
  }, [autosave, writer]);
  useEffect(() => {
    const hydrated = siteSettingsFromConfig({ ...data.site_config, ...settingsChanges.current });
    settingsRef.current = hydrated; setSiteSettings(hydrated);
  }, [data.site_config]);
  return [siteSettings, updateSiteSettings] as const;
}
