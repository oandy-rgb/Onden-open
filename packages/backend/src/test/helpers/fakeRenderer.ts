// A stand-in for the frontend SSR server, for the tests of the static copy
// (modules/website/publishing/staticSite.ts). It answers the contract of
// frontend/src/pages/site/* from the SAME served site the real server reads
// through GET /api/site (servedSite.loadServedSite): the page list, one page per
// note and tag, a 404, the feed, the sitemap and a stylesheet with a font. The
// pages are plain HTML around md2html, not the real frame — what these tests
// check is which pages the copy holds, what it does to their addresses, and
// what the media pass does to their images.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadServedSite } from "../../modules/website/publishing/servedSite.js";
import { esc, md2html } from "../../modules/website/publishing/htmlUtils.js";

type Node = { id: string; title: string; slug: string; markdown: string };

/** `workspaceId` may be a function for a test that works in a new workspace per run. */
export async function startFakeRenderer(workspaceId: string | (() => string)): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://renderer");
      const path = decodeURIComponent(url.pathname);
      const site = await loadServedSite(typeof workspaceId === "function" ? workspaceId() : workspaceId);
      const nodes = (site.payload.nodes ?? []) as Node[];
      const presentation = (site.payload.presentation ?? {}) as {
        site?: { brand?: string; logo?: string; allow_indexing?: boolean };
        design?: { tag_pages?: Record<string, { slug: string; name: string }> };
      };
      const tags = Object.values(presentation.design?.tag_pages ?? {});
      const brand = presentation.site?.brand ?? "Site";
      const logo = presentation.site?.logo;
      const frame = (title: string, body: string) =>
        `<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>${esc(title)}</title>` +
        `<link rel="canonical" href="https://live.example/site/" /><link rel="stylesheet" href="/_astro/site.css"></head>` +
        `<body><a href="/site/">${logo ? `<img src="${esc(logo)}" alt="">` : esc(brand)}</a><main>${body}</main></body></html>`;
      const send = (status: number, type: string, body: string | Buffer) => {
        res.writeHead(status, { "content-type": type });
        res.end(body);
      };

      if (path === "/site/static-pages.json") {
        return send(200, "application/json", JSON.stringify({
          pages: ["/site/", ...nodes.map((n) => `/site/${n.slug}/`), ...tags.map((t) => `/site/tag/${t.slug}/`)],
          origin: "https://live.example",
          allowIndexing: presentation.site?.allow_indexing !== false,
        }));
      }
      if (path === "/site/feed.xml") return send(200, "application/rss+xml", `<rss><channel>${nodes.map((n) => `<item><link>https://live.example/site/${n.slug}</link></item>`).join("")}</channel></rss>`);
      if (path === "/site/sitemap.xml") return send(200, "application/xml", `<urlset>${nodes.map((n) => `<url><loc>https://live.example/site/${n.slug}/</loc></url>`).join("")}</urlset>`);
      if (path === "/_astro/site.css") return send(200, "text/css", "@font-face{src:url(/_astro/f.woff2) format('woff2'),url(/_astro/f.woff) format('woff')}");
      if (path === "/_astro/f.woff2") return send(200, "font/woff2", Buffer.from([0, 1, 2]));
      if (path === "/site/") {
        return send(200, "text/html", frame(brand, nodes.map((n) => `<a href="/site/${n.slug}/">${esc(n.title)}</a>`).join(" ")));
      }
      const tag = /^\/site\/tag\/([^/]+)\/?$/.exec(path)?.[1];
      if (tag && tags.some((t) => t.slug === tag)) return send(200, "text/html", frame(tag, "<p>tag</p>"));
      const slug = /^\/site\/([^/]+)\/?$/.exec(path)?.[1];
      const note = nodes.find((n) => n.slug === slug);
      if (note) {
        return send(200, "text/html", frame(note.title, `<h1>${esc(note.title)}</h1>${md2html(note.markdown, { pages: nodes, from: note.id })}`));
      }
      return send(404, "text/html", frame("Not found", "<p>not found</p>"));
    })().catch((e) => send500(res, e));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const previous = process.env.SITE_SSR_URL;
  process.env.SITE_SSR_URL = url;
  return {
    url,
    close: () => new Promise<void>((resolve) => {
      if (previous === undefined) delete process.env.SITE_SSR_URL;
      else process.env.SITE_SSR_URL = previous;
      server.close(() => resolve());
    }),
  };
}

function send500(res: import("node:http").ServerResponse, e: unknown): void {
  res.writeHead(500, { "content-type": "text/plain" });
  res.end(e instanceof Error ? e.message : String(e));
}
