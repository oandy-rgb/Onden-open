// The public origin of the site, for canonical URLs and the sitemap. The SSR
// server sits behind a proxy, so the request URL carries the container's
// address, not the one readers use. APP_URL (the same setting the backend uses
// for its public address) is the configured origin; the request's own origin
// is only the fallback for a deployment that sets none.

/** `https://example.com` — no path, no trailing slash. */
export function publicOrigin(requestUrl: URL, env: Record<string, string | undefined> = process.env): string {
  const configured = env.APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed APP_URL is a deployment mistake; the request origin still serves a valid page.
    }
  }
  return requestUrl.origin;
}

/** The public address of a path on this site (`/site/foo/` → `https://example.com/site/foo/`). */
export function publicUrl(requestUrl: URL, path: string, env?: Record<string, string | undefined>): string {
  return `${publicOrigin(requestUrl, env)}${path}`;
}
