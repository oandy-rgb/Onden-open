import type { MiddlewareHandler } from "hono";

/** Which build of the app this server is, on every response (a deploy passes
 *  the git sha, the same ONDEN_BUILD_ID the frontend image is built with). A
 *  client running another build offers a reload (frontend lib/buildVersion.ts).
 *  `id` empty or unset: no header, so no client is ever told it is old by a
 *  server that does not know. */
export function buildHeader(id: string | undefined): MiddlewareHandler | null {
  const build = id?.trim();
  if (!build) return null;
  return async (c, next) => {
    await next();
    c.res.headers.set("X-Onden-Build", build);
  };
}
