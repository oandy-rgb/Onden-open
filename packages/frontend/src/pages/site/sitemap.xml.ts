// Sitemap for the published site — /site/, every published note and every tag page.
// URLs use the configured public origin (APP_URL), not the proxied request address.
// Served dynamically (the static @astrojs/sitemap integration can't know the
// runtime host); served even when allow_indexing=false — the robots meta on
// the pages handles indexing.
export const prerender = false;

import type { APIRoute } from "astro";
import { escapeHtml } from "@onden/markdown";
import { dateIdAt } from "../../lib/localDate";
import { fetchSiteSnapshot } from "../../lib/siteFeed";
import { publicOrigin } from "../../lib/siteOrigin";

export const GET: APIRoute = async ({ request }) => {
  const snapshot = await fetchSiteSnapshot();
  if (!snapshot) return new Response("Site unavailable", { status: 503 });

  const origin = publicOrigin(new URL(request.url));

  const urls = [
    `  <url>\n    <loc>${escapeHtml(`${origin}/site/`)}</loc>\n  </url>`,
    ...snapshot.tagSlugs.map((slug) => `  <url>\n    <loc>${escapeHtml(`${origin}/site/tag/${slug}/`)}</loc>\n  </url>`),
    ...snapshot.nodes.map((n) => {
      const lastmod = n.updated_at ? dateIdAt(new Date(n.updated_at), snapshot.timeZone, snapshot.dayStartHour) : "";
      return [
        "  <url>",
        `    <loc>${escapeHtml(`${origin}/site/${n.slug}`)}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
