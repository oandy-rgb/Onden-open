import { MAX_HELLO_BYTES, MAX_OBJECT_BYTES, SESSION_MAX_LIFETIME_MS } from "./limits.ts";
import type { Outcome, RateLimiterApi, RegistryApi, RelayErrorCode, SessionApi } from "./types.ts";

export interface RelayDeps {
  session(sessionId: string): SessionApi;
  /** One limiter per source address. */
  rateLimiter(sourceKey: string): RateLimiterApi;
  registry: RegistryApi;
  /** Value for Access-Control-Allow-Origin. `*` is fine: nothing here uses cookies, only bearer tokens. */
  allowedOrigin: string;
  now?: () => number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
/** `m.<id>` replaceable progress list; `final` the final list; `c.<fileId>.<index>` one chunk. */
const OBJECT_NAME = /^(m\.[A-Za-z0-9_-]{1,64}|final|c\.[A-Za-z0-9_-]{1,64}\.[0-9]{1,9})$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

const STATUS_BY_ERROR: Record<RelayErrorCode, string> = {
  not_found: "not found",
  unauthorized: "credentials required",
  bad_request: "bad request",
  conflict: "conflict",
  too_large: "too large",
  session_full: "session full",
  unsupported_media_type: "unsupported media type",
  rate_limited: "too many requests",
  capacity: "relay is full",
};

function corsHeaders(origin: string): Headers {
  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-read-token-hash",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}

function respond(origin: string, status: number, body: BodyInit | null, contentType?: string, extra?: Record<string, string>): Response {
  const headers = corsHeaders(origin);
  if (contentType) headers.set("content-type", contentType);
  for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
  return new Response(status === 204 || status === 201 && body === null ? null : body, { status, headers });
}

const errorResponse = (origin: string, status: number, error: RelayErrorCode): Response =>
  respond(origin, status, JSON.stringify({ error, message: STATUS_BY_ERROR[error] }), "application/json", status === 429 || status === 503 ? { "retry-after": "60" } : undefined);

async function readLimited(request: Request, max: number): Promise<Uint8Array | "too_large"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return "too_large";
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return "too_large";
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bearer(request: Request): string | undefined {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

/** The relay's whole HTTP surface, as a function from Request to Response. Runs unchanged in a Worker, in Node 22 and in tests. */
export function createRelayHandler(deps: RelayDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const origin = deps.allowedOrigin;
  const failure = (outcome: Extract<Outcome<unknown>, { ok: false }>): Response => errorResponse(origin, outcome.status, outcome.error);
  const reject = (status: number, error: RelayErrorCode): Response => errorResponse(origin, status, error);

  return async (request) => {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((s) => s !== "");
    // /v1/s/:sid[/hello | /o | /o/:name]
    if (segments[0] !== "v1" || segments[1] !== "s" || !SESSION_ID.test(segments[2] ?? "")) return reject(404, "not_found");
    const sessionId = segments[2]!;
    const tail = segments.slice(3);
    const kind = tail.length === 0 ? "session" : tail[0] === "hello" && tail.length === 1 ? "hello" : tail[0] === "o" && tail.length === 1 ? "list" : tail[0] === "o" && tail.length === 2 ? "object" : undefined;
    if (!kind) return reject(404, "not_found");
    if (kind === "object" && !OBJECT_NAME.test(tail[1]!)) return reject(404, "not_found");

    const allowed: Record<typeof kind, string[]> = { session: ["DELETE"], hello: ["GET", "PUT"], list: ["GET"], object: ["GET", "PUT"] };
    if (request.method === "OPTIONS") return respond(origin, 204, null);
    if (!allowed[kind].includes(request.method)) return respond(origin, 405, null, undefined, { allow: allowed[kind].join(", ") });

    const source = request.headers.get("cf-connecting-ip") ?? "unknown";
    const isHelloPut = kind === "hello" && request.method === "PUT";
    const limited = await deps.rateLimiter(source).hit(isHelloPut);
    if (!limited.ok) return failure(limited);

    const session = deps.session(sessionId);

    if (kind === "hello") {
      if (request.method === "GET") {
        const result = await session.getHello();
        return result.ok ? respond(origin, 200, result.value, "application/octet-stream") : failure(result);
      }
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/octet-stream") return reject(415, "unsupported_media_type");
      const body = await readLimited(request, MAX_HELLO_BYTES);
      if (body === "too_large") return reject(413, "too_large");
      const slot = await deps.registry.acquire(sessionId, now() + SESSION_MAX_LIFETIME_MS);
      if (!slot.ok) return failure(slot);
      const result = await session.putHello(body);
      return result.ok ? respond(origin, result.status, null) : failure(result);
    }

    const token = bearer(request);
    if (token === undefined || !TOKEN.test(token)) return reject(401, "unauthorized");

    if (kind === "session") {
      const result = await session.destroy(token);
      return result.ok ? respond(origin, 204, null) : failure(result);
    }
    if (kind === "list") {
      const result = await session.listObjects(token);
      return result.ok ? respond(origin, 200, JSON.stringify({ objects: result.value }), "application/json") : failure(result);
    }

    const name = tail[1]!;
    if (request.method === "GET") {
      const result = await session.getObject(name, token);
      return result.ok ? respond(origin, 200, result.value, "application/octet-stream") : failure(result);
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/octet-stream") return reject(415, "unsupported_media_type");
    const readTokenHash = request.headers.get("x-read-token-hash") ?? undefined;
    if (readTokenHash !== undefined && !HASH_HEX.test(readTokenHash)) return reject(400, "bad_request");
    const body = await readLimited(request, MAX_OBJECT_BYTES);
    if (body === "too_large") return reject(413, "too_large");
    const result = await session.putObject(name, body, token, readTokenHash);
    return result.ok ? respond(origin, result.status, null) : failure(result);
  };
}
