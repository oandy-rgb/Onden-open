// Settings › Website — the site's language, description, search-engine and
// analytics choices and custom domain. The name, tagline, logo and icon stay
// in the studio (studio/SiteSettingsPanel). Both write through the website
// writer's saveSettings, each sending only the keys it changed (the server
// merges them), so the two open at once never overwrite each other. Each key
// has its own autosave entry, so a quick edit of one never drops another's.
// Opening the page writes nothing: a site without a language shows the one
// the live site uses (zh-TW) and stores a language only when the owner picks one.

import { useEffect, useState } from "react";
import { useAppSelector } from "../../lib/appStore";
import { useIsOwner } from "../../lib/capabilities";
import { onPageHide } from "../../lib/pageHide";
import { createAutosave } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { siteSettingsFromConfig } from "../../lib/siteSettings";
import type { SettingContext } from "../../lib/settingsTypes";
import {
  ANALYTICS_PROVIDERS, SITE_LOCALES, analyticsProviderOf, parseCustomDomain, showsAnalyticsId, siteLocaleOf,
} from "./siteBasics";
import { makeWebsiteWriter } from "./websiteWriter";
import { Checkbox, Select, TextArea, TextField } from "../../components/ui";

const writer = makeWebsiteWriter();

export default function SiteBasicsSettings(_props: { ctx: SettingContext }) {
  const t = useT();
  const isOwner = useIsOwner();
  const config = useAppSelector((s) => s.data.site_config);
  const site = siteSettingsFromConfig(config);
  const storedLocale = siteLocaleOf(config);
  // The writers report a failed save themselves; the status is not shown again.
  const [autosave] = useState(() => createAutosave(() => {}));
  const [description, setDescription] = useState(site.description);
  const [analyticsId, setAnalyticsId] = useState(site.analyticsId);
  const [domain, setDomain] = useState(site.customDomain);
  const domainCheck = parseCustomDomain(domain);

  // Controls that change a stored value show the new choice at once; the
  // choice is dropped again when its save settles, so a refused save returns
  // to the stored value (the writer has already told the person why).
  const [shown, setShown] = useState<Record<string, string | boolean>>({});
  const save = (key: string, value: string | boolean) =>
    autosave.schedule(key, (options) => writer.saveSettings({ [key]: value }, options), 600);
  const choose = (key: string, value: string | boolean) => {
    setShown((cur) => ({ ...cur, [key]: value }));
    autosave.schedule(key, async (options) => {
      try {
        return await writer.saveSettings({ [key]: value }, options);
      } finally {
        setShown((cur) => {
          if (cur[key] !== value) return cur;
          const { [key]: _settled, ...rest } = cur;
          return rest;
        });
      }
    }, 600);
  };
  const locale = (shown.locale as string | undefined) ?? storedLocale;
  const allowIndexing = (shown.allow_indexing as boolean | undefined) ?? site.allowIndexing;
  const analyticsProvider = (shown.analytics_provider as string | undefined) ?? site.analyticsProvider;

  // Leaving the panel, or hiding / closing the page, sends what is still waiting out its 600 ms (keepalive).
  useEffect(() => {
    const stop = onPageHide(() => { void autosave.flush(true); });
    return () => { stop(); void autosave.flush(true); };
  }, [autosave]);

  const provider = analyticsProviderOf(analyticsProvider);
  return (
    <div className="site-basics-setting">
      <label className="settings-row">
        <span className="settings-label">{t("Site language")}</span>
        <Select value={locale} disabled={!isOwner} onChange={(e) => choose("locale", e.target.value)}>
          {SITE_LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </Select>
      </label>

      <label className="settings-row">
        <span className="settings-label">{t("Site description")}</span>
        <TextArea className="settings-input" rows={3} value={description} disabled={!isOwner}
          onChange={(e) => { setDescription(e.target.value); save("description", e.target.value); }} />
      </label>
      <p className="settings-hint">{t("Shown in search results and when the site is shared.")}</p>

      <label className="settings-row">
        <Checkbox checked={allowIndexing} disabled={!isOwner}
          onChange={(e) => choose("allow_indexing", e.target.checked)} />
        <span>{t("Let search engines list this site")}</span>
      </label>

      <label className="settings-row">
        <span className="settings-label">{t("Visitor statistics")}</span>
        <Select value={analyticsProvider} disabled={!isOwner} onChange={(e) => choose("analytics_provider", e.target.value)}>
          <option value="">{t("Not used")}</option>
          {ANALYTICS_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </Select>
      </label>
      {showsAnalyticsId(analyticsProvider) && provider && (
        <label className="settings-row">
          <span className="settings-label">{t(provider.idLabel)}</span>
          <TextField className="settings-input" value={analyticsId} placeholder={provider.idPlaceholder} disabled={!isOwner}
            onChange={(e) => { setAnalyticsId(e.target.value); save("analytics_id", e.target.value.trim()); }} />
        </label>
      )}

      <label className="settings-row">
        <span className="settings-label">{t("Custom domain")}</span>
        <TextField className="settings-input" value={domain} placeholder="www.example.com" disabled={!isOwner}
          aria-invalid={!domainCheck.ok}
          onChange={(e) => {
            setDomain(e.target.value);
            const next = parseCustomDomain(e.target.value);
            // A half-typed address that stops parsing must not leave its last valid prefix ("www.ex") waiting to save.
            if (next.ok) save("custom_domain", next.host);
            else autosave.discard("custom_domain");
          }} />
      </label>
      {!domainCheck.ok && <p className="settings-hint" role="alert">{t("Enter just the address, like www.example.com.")}</p>}
      <p className="settings-hint">{t("The domain only works once the site is pushed to GitHub Pages.")}</p>

      {!isOwner && <p className="settings-hint">{t("Only the workspace owner can change this.")}</p>}
      <p className="settings-hint">{t("Changes apply to the public site right away.")}</p>
    </div>
  );
}
