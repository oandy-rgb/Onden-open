// The live site's search index: the files of the stored static copy's Pagefind
// index, the very ones the zip carries (backend siteBundle.ts), so live and
// static search are one thing. The backend answers 404 until the copy of the
// current site exists; the page's search box
// stays hidden until the index answers (components/siteFrame/SiteSearch.astro).
export const prerender = false;

import type { APIRoute } from "astro";

const API_BASE = process.env.SSR_API_URL ?? import.meta.env.PUBLIC_API_BASE_URL ?? "http://localhost:8787";
const PASSED = ["content-type", "cache-control", "etag", "retry-after"];

export const GET: APIRoute = async ({ params, request }) => {
  const headers: Record<string, string> = {};
  const revalidate = request.headers.get("if-none-match");
  if (revalidate) headers["if-none-match"] = revalidate;
  try {
    const res = await fetch(`${API_BASE}/api/site/search.idx/${(params.file ?? "").split("/").map(encodeURIComponent).join("/")}`, { headers });
    const out = new Headers();
    for (const name of PASSED) {
      const value = res.headers.get(name);
      if (value) out.set(name, value);
    }
    out.set("X-Content-Type-Options", "nosniff");
    return new Response(res.status === 304 ? null : res.body, { status: res.status, headers: out });
  } catch {
    return new Response("Search unavailable", { status: 503 });
  }
};
