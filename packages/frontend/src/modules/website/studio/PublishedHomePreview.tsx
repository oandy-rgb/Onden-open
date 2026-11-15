// 「看網站」 in the publish dialog: the home page of the candidate, drawn by
// the same components as the site, from the candidate's own design and rows.
import { useMemo } from "react";
import { readSiteData, type SiteData, type SiteSnapshot } from "../../../components/siteFrame";
import type { PublishPreview } from "@onden/contract";
import SiteRender from "../SiteRender";

export default function PublishedHomePreview({ site }: { site: PublishPreview["site"] }) {
  const data = useMemo<SiteData>(() => readSiteData(site as SiteSnapshot), [site]);
  return <SiteRender data={data} page={{ kind: "home" }} />;
}
