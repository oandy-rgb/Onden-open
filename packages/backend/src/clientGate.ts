import type { MiddlewareHandler } from "hono";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER, SERVER_PROTOCOL_HEADER, isSyncPath, protocolMismatch } from "@onden/markdown";
import type { ActorCtx } from "./types.js";
import { isPerson } from "./spine/authority.js";

/** Says which protocol this server speaks, on every response (refusals and 401s too), so a client can tell whether
 *  the server is too old for it. See CLIENT_PROTOCOL in @onden/markdown for when the number changes. */
export function serverProtocolHeader(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set(SERVER_PROTOCOL_HEADER, String(CLIENT_PROTOCOL));
  };
}

/** Routes whose writes carry a note's text. A browser page that sends no protocol header predates block anchors
 *  (段落錨點批 3) and would send text with `^id` marks to a server whose notes no longer have them. */
const NOTE_WRITE_PREFIXES = ["/api/nodes", "/api/sync", "/api/versions", "/api/history"];
const underPrefix = (path: string, prefixes: readonly string[]) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/** One version policy for every request that says which protocol it speaks (X-Onden-Client-Protocol): the protocols
 *  must be equal (CLIENT_PROTOCOL in @onden/markdown). Otherwise its writes and its sync requests are refused with 426:
 *  `client_too_old` from an older client (the app shows 「重新載入」), `server_too_old` from a newer one (the app says
 *  the server needs updating). Either way the app keeps what the person typed (writeErrors: a queued write waits, it is
 *  not a rejection). Other reads pass. A request without the header (MCP, API tokens, health checks, the public site, scripts) is not asked —
 *  except a browser session's write to notes, which predates the header and is refused as before. */
export function clientProtocolGate(): MiddlewareHandler<{ Variables: { actor: ActorCtx | null } }> {
  return async (c, next) => {
    const method = c.req.method;
    const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
    if (method === "OPTIONS") return next();
    const path = c.req.path;
    // A blank header says nothing: it is "no header", not a version.
    const header = c.req.header(CLIENT_PROTOCOL_HEADER)?.trim() || undefined;
    if (header !== undefined) {
      // Sync is asked whatever its method (some of it is POST that only reads): a client below the oldest accepted
      // version would build its copy from a shape it misreads.
      const asked = !isRead || isSyncPath(path);
      const mismatch = asked ? protocolMismatch(header) : null;
      if (mismatch) return c.json({ error: mismatch === "older" ? "client_too_old" : "server_too_old" }, 426);
      return next();
    }
    if (isRead || !underPrefix(path, NOTE_WRITE_PREFIXES)) return next();
    // Only a page is asked: a browser always sends Origin on a write (the CSRF guard in app.ts counts on it), a script or curl does not.
    if (!c.req.header("origin")) return next();
    // Only a person's own session: a request authenticated by a token or a temporary session's credential is not a page. Decided from the
    // verified actor (app.ts refuses a bearer that does not resolve), never from the mere presence of an Authorization header.
    const actor = c.get("actor");
    if (!actor || actor.type !== "human" || !isPerson(actor)) return next();
    return c.json({ error: "client_too_old" }, 426);
  };
}
