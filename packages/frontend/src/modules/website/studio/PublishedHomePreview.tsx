// 「看網站」 in the publish dialog: the home page of the candidate, drawn by
// the same components as the site, from the candidate's own design and rows.
import { useMemo } from "react";
import { readSiteData, type SiteData, type SiteSnapshot } from "../../../components/siteFrame";
import type { PublishPreview } from "@onden/contract";
import { useT } from "../../../lib/i18n";
import { accountSiteLocale } from "../../../lib/siteSettings";
import SiteRender from "../SiteRender";

/** The words the site draws itself ("Latest", "All articles") follow the SITE's language (its setting, the same one
 *  the published pages use), not the app's. The app only says so, in its own language, when the two differ. */
const SITE_LANGUAGE_NAMES: Record<string, string> = { "zh-TW": "繁體中文", en: "English", ja: "日本語" };

export default function PublishedHomePreview({ site }: { site: PublishPreview["site"] }) {
  const data = useMemo<SiteData>(() => readSiteData(site as SiteSnapshot), [site]);
  const t = useT();
  const siteLocale = typeof data.site.locale === "string" ? data.site.locale : undefined;
  const differs = siteLocale !== undefined && siteLocale !== accountSiteLocale();
  return (
    <>
      {differs && (
        <p className="publish-review-hint publish-review-site-note">
          {t("The site is written in {language}, so its headings read that way. Change it in the site's settings.", { language: SITE_LANGUAGE_NAMES[siteLocale] ?? siteLocale })}
        </p>
      )}
      <SiteRender data={data} page={{ kind: "home" }} />
    </>
  );
}
