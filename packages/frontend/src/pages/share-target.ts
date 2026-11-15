// 「分享 → Onden」 fallback: the service worker answers the manifest's
// share_target POST (public/sw.js) and keeps the shared items. Before it
// controls the page (the first open after install, cleared site data) the
// POST reaches the server: open quick capture rather than an error page. The
// shared items are lost on this path; sharing again works once the worker runs.
export const prerender = false;

import type { APIRoute } from "astro";

const toCapture: APIRoute = () => new Response(null, { status: 303, headers: { Location: "/?capture=1" } });

export const POST = toCapture;
export const GET = toCapture;
