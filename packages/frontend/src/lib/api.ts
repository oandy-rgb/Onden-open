import { ensureSentenceWording, fieldClashMessage, serverErrorMessage } from "./serverErrors";
import { boundAccountId, matchesAccountStorageServer } from "./accountStorage";
import { PREFS, getPref, removePref, setPref } from "./prefs";
import { t } from "./i18n";
import { pageOrigin } from "./pageUrl";

export { pageOrigin };
import { CLIENT_NOW_HEADER, CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER, DEVICE_ID_HEADER, SERVER_PROTOCOL_HEADER, isSyncPath } from "@onden/markdown";
import { deviceId } from "./deviceId";
import { currentProtocolBlock, noteRefusedAsTooOld, noteServerProtocol, setProtocolProbe } from "./protocolGate";
import type { Bootstrap, Tag as WireTag } from "@onden/contract";
import type { TagModuleBehaviour } from "./tagModules";
import { isAccessRevokedCode, notifyAccessRevoked } from "./accessRevoked";

// The wire shapes the server sends are declared once, in @onden/contract; the ~250 importers still reach them here.
export type {
  AiSuggestion, Bootstrap, ContentNode, DomainEvent, FieldDef, GraphPosition, NodeAttribute, NodeEdge, NodeTask, NotePointer, SchemaField, SiteConfig, Workspace,
} from "@onden/contract";

/** A tag as the server sends it (@onden/contract Tag), with `schema_behaviour` read through the app's own
 *  TagModuleBehaviour: the contract only says it is an object, the app knows the module switches inside. */
export type Tag = Omit<WireTag, "schema_behaviour"> & { schema_behaviour?: TagModuleBehaviour | null };

// True when a node row came from the slim bootstrap and its body is still on
// the server: markdown is empty but the server reported a non-empty body.
export function nodeNeedsBody(n: { markdown?: string; body_len?: number } | null | undefined): boolean {
  return !!n && (n.markdown ?? "") === "" && (n.body_len ?? 0) > 0;
}



/** The page's full address, the base relative links resolve against. */
export function pageHref(): string {
  return window.location.href;
}

/** Reload the page. Callers that must be testable keep their own seam (`pageLifecycle`, `chunkReloadPage`) around this. */
export function reloadPage(): void {
  window.location.reload();
}

export function getApiBase(): string {
  const stored = getPref(PREFS.apiBase);
  if (stored) {
    // Strip stale cross-origin overrides written by an earlier ServerSetup
    // flow (e.g. `http://localhost:8787`). Same-origin /api via nginx is
    // the intended setup; any absolute URL pointing at this page's host
    // on a different port is a leftover from the dev-direct-to-backend
    // era and will trigger CORS. Wipe it and fall through to build-time.
    if (typeof window !== "undefined" && /^https?:\/\//i.test(stored)) {
      try {
        const parsed = new URL(stored);
        if (parsed.hostname === window.location.hostname && parsed.port !== window.location.port) {
          removePref(PREFS.apiBase);
        } else {
          return stored;
        }
      } catch { removePref(PREFS.apiBase); }
    } else {
      return stored;
    }
  }
  return import.meta.env.PUBLIC_API_BASE_URL ?? "";
}

export type ServerCheck = { ok: true } | { ok: false; error: string };

/** Is `base` ("" = this page's origin) a reachable Onden server? The probe is
 *  GET /api/auth/providers: public (the APK checks before anyone can sign in,
 *  and a server without the native bypass answers 401 everywhere else) and
 *  Onden's own route, answering `{ providers: [...] }`. Any other reply —
 *  an HTML page, a different API, the WebView's own origin — is refused. */
export async function checkOndenServer(base: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<ServerCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/auth/providers`, { signal: controller.signal, credentials: "omit" });
    if (!res.ok) return { ok: false, error: t("This address is not an Onden server.") };
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || !Array.isArray((body as { providers?: unknown }).providers)) {
      return { ok: false, error: t("This address is not an Onden server.") };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: t("Unable to connect. Check URL and network.") };
  } finally {
    clearTimeout(timer);
  }
}

export type SetApiBaseResult = { ok: true; changed: boolean } | { ok: false; error: string };

/** The one way to change the backend (ServerSetup and Settings › Backend URL).
 *  Checks the server first and saves nothing when it is not Onden. A changed
 *  server reloads the page: the account binding, the local database and its
 *  write queue are scoped per server + account (lib/accountStorage) and fixed
 *  for a page lifetime, so the new page opens the new server's own store and
 *  the old server's queued writes stay with the old server. Until the reload,
 *  apiFetch refuses to send (matchesAccountStorageServer). */
export async function setApiBase(
  url: string,
  opts: { fetchImpl?: typeof fetch; reload?: () => void } = {},
): Promise<SetApiBaseResult> {
  const base = url.trim().replace(/\/+$/, "");
  const check = await checkOndenServer(base, opts.fetchImpl);
  if (!check.ok) return check;
  if (base === getApiBase()) return { ok: true, changed: false };
  setPref(PREFS.apiBase, base);
  (opts.reload ?? reloadPage)();
  return { ok: true, changed: true };
}

/**
 * Should the app boot straight into the workspace, or first show the
 * "Connect to backend server" (ServerSetup) wall?
 *
 * The wall is a jargon dead-end for non-technical newcomers, and it is
 * UNNECESSARY for the common deployment: when the frontend and `/api` share
 * an origin (the docker-compose / nginx setup, and any same-origin host),
 * relative `/api/...` calls just work with `getApiBase() === ""`. So in a
 * browser we default to ready and let same-origin resolve itself. The wall is
 * never the *only* way to point at a backend — Settings → Server → Backend URL
 * stays as the escape hatch for a frontend served from a separate origin.
 *
 * Returns false (→ show the wall) only when there is genuinely no usable
 * backend hint AND we are not in a browser that could reach same-origin —
 * e.g. SSR, or a native app with no server saved. Pure & window-injectable for tests.
 */
export function shouldSkipServerSetup(opts?: {
  isNative?: boolean;
  /** Whether the build baked a PUBLIC_API_BASE_URL (even ""); pass the raw
   *  `import.meta.env.PUBLIC_API_BASE_URL !== undefined`. */
  hasBuiltInBase?: boolean;
  /** Override window presence for SSR/unit tests. */
  inBrowser?: boolean;
}): boolean {
  const isNative = opts?.isNative ?? false;
  const hasBuiltInBase = opts?.hasBuiltInBase ?? false;
  const inBrowser = opts?.inBrowser ?? typeof window !== "undefined";
  // Native has no same-origin backend (its page is the WebView's own origin),
  // so it connects to a server first unless one is saved or baked in.
  if (isNative) return getApiBase() !== "";
  if (getApiBase()) return true; // explicit override or baked absolute URL
  if (hasBuiltInBase) return true; // build opted into a base (incl. same-origin "")
  return inBrowser; // same-origin /api via the reverse proxy is the default
}

function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${getApiBase()}${path}`;
}

/** Credentialed fetch to a backend path — returns the raw Response (no JSON
 *  parse, no throw). Use for endpoints that need the Response object: file
 *  uploads (FormData), blob/SVG bodies, or manual status handling. Always
 *  sends the session cookie cross-origin — the reason a bare fetch() to the
 *  backend 401s when frontend and backend are on different origins. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!matchesAccountStorageServer(getApiBase())) return Promise.reject(new ApiError(401, '{"error":"account_changed"}'));
  const headers = new Headers(init?.headers);
  const userId = boundAccountId();
  if (userId) headers.set("X-Onden-Expected-User", userId);
  // Which edition of the contract this page speaks: the server refuses a note write from a page too old for it (426).
  headers.set(CLIENT_PROTOCOL_HEADER, String(CLIENT_PROTOCOL));
  // Which device this write is from; the queue replays on the same device that wrote it, so the current id is the right one.
  headers.set(DEVICE_ID_HEADER, deviceId());
  // This device's clock now, so the server can date an edit made earlier by its age, not by this clock (backend clientClock.ts).
  headers.set(CLIENT_NOW_HEADER, String(Date.now()));
  // Protocol gate (lib/protocolGate.ts): while this page or the server is too old for the other, no write and no sync
  // request leaves the page (sync by path: some of it is POST that only reads). Refused here, before the network, so
  // the queue keeps what it has and nothing retries against the server. Other reads go out.
  const block = currentProtocolBlock();
  if (block && heldWhileBlocked(path, init?.method)) return Promise.reject(protocolBlockError(block));
  return fetch(apiUrl(path), { credentials: "include", ...init, headers }).then((response) => {
    serverBuildListener?.(response.headers?.get?.("X-Onden-Build") ?? null);
    if (response.status < 500 || response.status === 426) {
      noteServerProtocol(response.headers?.get?.(SERVER_PROTOCOL_HEADER) ?? null);
      // Refused as too old by a server that does not say which protocol it speaks (one before the header): the page is old.
      if (response.status === 426 && currentProtocolBlock() === null) noteRefusedAsTooOld();
      if (currentProtocolBlock() === "page_old") clientTooOldListener?.();
      // The first sync answer from a server of another protocol is not used either: this page would misread its shape.
      const nowBlocked = currentProtocolBlock();
      if (nowBlocked && isSyncPath(path)) throw protocolBlockError(nowBlocked);
    }
    return response;
  });
}

const heldWhileBlocked = (path: string, method: string | undefined) => isSyncPath(path) || !/^(GET|HEAD)$/i.test(method ?? "GET");
const protocolBlockError = (block: "page_old" | "server_old") =>
  new ApiError(426, JSON.stringify({ error: block === "page_old" ? "client_too_old" : "server_too_old" }));

/** While the server is too old for this page, the one request that still goes out: it tells the gate when that ends. */
setProtocolProbe(() => apiFetch("/api/me"));

/** Who hears that the server refused this page as too old (426 `client_too_old`: lib/buildVersion.ts offers the reload).
 *  Set once by the app, like the build listener. */
let clientTooOldListener: (() => void) | null = null;
export function setClientTooOldListener(listener: (() => void) | null): void {
  clientTooOldListener = listener;
}

/** Who hears which build the server says it is (X-Onden-Build on every API
 *  response; lib/buildVersion.ts). Set once by the app; api.ts must not import
 *  the store (the store imports this file). */
let serverBuildListener: ((serverBuild: string | null) => void) | null = null;
export function setServerBuildListener(listener: ((serverBuild: string | null) => void) | null): void {
  serverBuildListener = listener;
}

/** What the page holds when it has NO data at all (before the first load, or
 *  an offline start with no copy): no workspace, nothing to read, and the least
 *  privilege (a viewer who is not the owner and cannot review), so no owner-only
 *  setting or action is offered on top of nothing. `workspace.id` "" marks it:
 *  nothing real has that id. */
export const noWorkspaceData: Bootstrap = {
  bodies: "full",
  workspace: { id: "", name: "", slug: "", home_node_id: null },
  nodes: [],
  edges: [],
  tasks: [],
  suggestions: [],
  events: [],
  actor_role: "viewer",
  actor_is_owner: false,
  can_review: false,
  tags: [],
};

export type CanvasNodeEntry = {
  nodeId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
  folded?: boolean;
  subCanvasId?: string;
};
export type CanvasSection = { id: string; x: number; y: number; width: number; height: number; title: string; color?: string };
export type CanvasData = { nodes: CanvasNodeEntry[]; sections?: CanvasSection[] };
export type Canvas = { id: string; title: string; data: CanvasData; created_at: string; updated_at: string };
export type CanvasMeta = { id: string; title: string; created_at: string; updated_at: string };

// D7 governance: an unreviewed agent-authored domain event surfaced by
// GET /api/inbox. `restorable` is the coarse "can this be auto-undone on
// reject?" hint from the backend (false for external side effects).
export type InboxEvent = {
  id: string;
  actor_type: string;
  actor_id: string;
  actor_name?: string | null;
  event_type: string;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  external: boolean;
  restorable: boolean;
  /** The triggered_by ROOT of this event's cascade chain (== id when the
   *  event has no cause). Events sharing a root render as one batch card. */
  root_event_id?: string;
};

// A server-side collapsed batch: every unreviewed event sharing one
// triggered_by root (e.g. an RSS fetch's RSS_FETCHED marker + its article
// creates). Decided as a unit via POST /api/inbox/groups/:root/(approve|reject).
export type InboxGroup = {
  root_event_id: string;
  count: number;
  sample_titles: string[];
  actor_id: string;
  actor_name: string | null;
  event_ids: string[];
  latest_created_at: string;
  root_event: {
    id: string;
    event_type: string;
    target_type: string;
    target_id: string;
    payload: Record<string, unknown> | null;
    created_at: string;
  } | null;
};

// Filter-chip material: counts over the visible queue BEFORE actor/type
// narrowing, so a chip can show what selecting it would yield.
export type InboxFacets = {
  by_actor: Array<{ actor_id: string; actor_name: string | null; count: number }>;
  by_type: Array<{ event_type: string; count: number }>;
};

// D7 approve-BEFORE-apply: a HELD outbound effect (outbox status
// 'pending_approval') surfaced by GET /api/inbox/approvals. Unlike InboxEvent
// it has NOT happened yet — approve runs it, reject buries it forever.
export type PendingApproval = {
  id: string;
  effect_kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** API failure with the HTTP status + the server's readable detail when the
 *  body is the conventional {error, detail} JSON. message is human-usable
 *  (detail > error > raw text), so existing e.message call sites improve
 *  for free; .status lets write paths distinguish client errors (never
 *  retry) from transient ones (queue for the reconnect drain). The message
 *  comes from lib/serverErrors.ts (code first, so a reworded server sentence
 *  still reads in the user's language). Branch on .status/.code, never on
 *  the (localized) message. */
export class ApiError extends Error {
  status: number;
  code?: string;
  /** The parsed JSON body, when the response had one. */
  body?: unknown;
  constructor(status: number, rawBody: string) {
    let message = rawBody;
    let code: string | undefined;
    let body: unknown;
    try {
      const parsed = JSON.parse(rawBody) as { error?: string; detail?: unknown };
      body = parsed;
      code = typeof parsed.error === "string" ? parsed.error : undefined;
      message = (code === "field_name_inherited" ? fieldClashMessage((parsed as { clashes?: unknown }).clashes) : null)
        ?? serverErrorMessage(code, typeof parsed.detail === "string" ? parsed.detail : undefined);
    } catch { message = serverErrorMessage(undefined, undefined); /* non-JSON body (a proxy page) — never shown */ }
    // A permission denial from the write spine answers 403 with a free sentence
    // and no known code (or a proxy answers 403 with a page): whoever reads
    // this message, it is "no permission", never the generic server-error one.
    if (status === 403 && message === serverErrorMessage(undefined, undefined)) message = serverErrorMessage("forbidden", undefined);
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** A failed response's body, ready for `new ApiError(status, body)`: its wording is
 *  loaded first when only the on-demand sentence table can word it. */
export async function readErrorBody(response: Response): Promise<string> {
  const body = await response.text();
  await ensureSentenceWording(body);
  return body;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await apiFetch(path, { ...init, headers });
  if (!response.ok) {
    const error = new ApiError(response.status, await readErrorBody(response));
    if (isAccessRevokedCode(error.status, error.code)) notifyAccessRevoked();
    throw error;
  }
  if (headers.get("Accept") === "text/plain") return response.text() as Promise<T>;
  return response.json() as Promise<T>;
}

/** A read that sends a body (a projection, a query, a lookup): POST because
 *  the request carries data, but nothing changes on the server. Never use it
 *  for a mutation: writes go through lib/data (sendWrite or the write queue). */
export function postRead<T>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  return api<T>(path, { ...init, method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** postRead for a caller that reads the response itself (a stream). */
export function postReadResponse(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return apiFetch(path, { ...init, method: "POST", headers, body: JSON.stringify(body) });
}

/** Bound a read to 15 seconds, including its body parsing. Cancels the transport
 * and ignores late results; an optional caller signal retires a stale query.
 * Use only for reads (projection POSTs included), never a mutation whose commit
 * may have succeeded even when its response is lost. */
export async function readWithDeadline<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let interrupt!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  const abort = (reason: unknown) => { controller.abort(reason); interrupt(reason); };
  const retire = () => abort(signal?.reason ?? new DOMException(t("Read cancelled"), "AbortError"));
  signal?.addEventListener("abort", retire, { once: true });
  const timer = setTimeout(() => abort(new DOMException(t("Read timed out"), "TimeoutError")), 15_000);
  try { return await Promise.race([read(controller.signal), interrupted]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", retire);
  }
}

// ── Tag merge (P2) ───────────────────────────────────────────────────────────
// Fold #source into #target. The backend applies #target's FULL contract to
// every mover (defaults, templates, automation) and then soft-deletes #source
// — junction rows survive, so undeleting #source from the Trash dissolves the
// merge. Preview first, always: the merge endpoint is admin-only and the
// preview is the plain-language blast radius shown before the act.

export type TagMergePreview = {
  source: { id: string; name: string };
  target: { id: string; name: string };
  /** Notes that carry #source but not #target yet — they gain #target. */
  members_gaining_target: number;
  /** Notes already carrying both — unchanged by the merge. */
  already_in_target: number;
  /** Schema fields only #source defines; their values stay as plain properties. */
  fields_only_in_source: string[];
  /** Functions #source has itself: the merge does not give them to #target. */
  functions_not_carried: number;
  /** Views #source has itself: the merge does not give them to #target. */
  views_not_carried: number;
  /** Tags extending #source that will extend #target instead (D57). */
  extenders_repointed: number;
  reversible: boolean;
};

export type TagMergeResult = {
  merged: boolean;
  members_gained_target: number;
  source_deleted: boolean;
};

export function fetchTagMergePreview(sourceId: string, targetId: string): Promise<TagMergePreview> {
  return api<TagMergePreview>(`/api/tags/${sourceId}/merge-preview?target=${encodeURIComponent(targetId)}`);
}

