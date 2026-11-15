// The single-note HTML export (GET /api/nodes/:id/export.html): one note, as
// ONE self-contained file. Pure, no DB access.
//
// This is not the site's static copy (staticSite.ts) and does not go through the
// site's SSR pages: the export is of the note's CURRENT text — a note that may
// not be published, with its query blocks evaluated as the exporter — while the
// site renders only the frozen snapshot, by address. It therefore keeps its own
// small page around the one Markdown pipeline (md2html), styled by the site
// settings (buildNoteExportCss).

import { esc, md2html, publishedCspMetaTag } from "./htmlUtils.js";
import { buildNoteExportCss } from "./css.js";
import { siteLang, type DiagramLayout, type FrozenQueryBlock, type ServedPage } from "@onden/markdown";
import type { Manifest } from "./types.js";

/** `query_blocks`: the note's query blocks' results, frozen for this export
 *  (queryBlocks.ts freezeQueryBlocks, D113). `sitePages`: the served site's
 *  pages — a [[link]] to one points at its page on the site
 *  (`/site/<served slug>`), any other reads as plain text. The <body> carries
 *  `site-root` so owner CSS written against it applies here too. */
export function buildSingleNoteHtml(
  node: { id?: string; title: string; slug?: string; markdown: string; query_blocks?: readonly FrozenQueryBlock[] },
  manifest: Manifest,
  sitePages: readonly ServedPage[] = [],
  /** The site's precompiled diagrams by block text: a block of the note with the same text is drawn, any other stays code. */
  diagrams?: ReadonlyMap<string, DiagramLayout>,
): string {
  const css = buildNoteExportCss(manifest);
  const brand = manifest.site?.brand ?? "";
  const locale = (manifest.site as { locale?: string } | undefined)?.locale;
  const lang = siteLang(locale);
  const title = esc(node.title || "Untitled");
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
${publishedCspMetaTag({ variant: "static", webfonts: (manifest.tokens as { webfonts?: boolean } | undefined)?.webfonts === true })}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}${brand ? ` — ${esc(brand)}` : ""}</title>
<style>${css}</style>
</head>
<body class="site-root">
<main class="note-export">
  <article class="markdown-body"><h1>${title}</h1>${md2html(node.markdown, { pages: sitePages, from: node.id, locale, queryBlocks: node.query_blocks ?? [], diagrams })}</article>
</main>
</body>
</html>`;
}
