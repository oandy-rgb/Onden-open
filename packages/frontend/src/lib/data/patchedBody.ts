import { ApiError } from "../api";
import { makePatch, MAX_REQUEST_BYTES, UUID_SOURCE, INK_PAGE_ATTRS } from "@onden/markdown";

// The one place a write that carries a whole value plus the value it was made
// from (its merge base) is turned into a patch (docs/architecture/patch-writes.md).
// Writers and the offline queue keep the whole request, as they always did; the
// request is converted only at the moment it is sent (writeQueue.ts), so the
// base is the value the previous write left — after a queued write went out
// ahead of it, that is what the server holds.
//
// The server answers 409 `patch_base_unknown` when it cannot give the base
// back (another device saved since and the base is not one of its versions);
// the sender then sends the whole request once (`wholeBody`).

type PatchRoute = {
  method: string;
  path: RegExp;
  /** The body fields: the whole value, its base, and the patch that replaces both. */
  value: string; base: string; patch: string;
  /** A whole request over the proxy's cap is sent without its base (the
   *  server then stores the value as sent); the note body never was. */
  dropsBaseWhenTooBig?: boolean;
};

// A drawing's or a page layer's value: the key names are the ones the server
// merges (services/attributeWrites.ts MERGED_KEYS).
const MERGED_ATTRIBUTE = new RegExp(`^/api/nodes/${UUID_SOURCE}/attributes/(?:${INK_PAGE_ATTRS.join("|")}|page_text|page_images)$`, "i");

const ROUTES: PatchRoute[] = [
  { method: "PATCH", path: new RegExp(`^/api/nodes/${UUID_SOURCE}$`, "i"), value: "markdown", base: "base_markdown", patch: "markdown_patch" },
  { method: "PUT", path: MERGED_ATTRIBUTE, value: "value", base: "base_value", patch: "value_patch", dropsBaseWhenTooBig: true },
];

const BASE_BUDGET_BYTES = MAX_REQUEST_BYTES - 1024 * 1024;

/** Under this many UTF-16 units (value and base together) the whole request is
 *  as small as the patch's envelope: nothing to save, so it is sent as is. */
export const MIN_PATCH_UNITS = 2048;

const routeOf = (method: string | undefined, path: string): PatchRoute | undefined =>
  ROUTES.find((route) => route.method === method?.toUpperCase() && route.path.test(path));

type Fields = Record<string, unknown>;
function parseFields(body: BodyInit | null | undefined): Fields | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Fields : null;
  } catch { return null; }
}

/** The request body to send for `body`, with the value and its base replaced by
 *  a patch; null when the request is not one that patches, carries no base,
 *  is small, or the patch would not be smaller. */
export function patchedBody(method: string | undefined, path: string, body: BodyInit | null | undefined): string | null {
  const route = routeOf(method, path);
  const fields = route ? parseFields(body) : null;
  if (!route || !fields) return null;
  const { value, base } = { value: fields[route.value], base: fields[route.base] };
  if (typeof value !== "string" || typeof base !== "string") return null;
  if (value.length + base.length < MIN_PATCH_UNITS) return null;
  const { [route.value]: _whole, [route.base]: _base, ...rest } = fields;
  const patched = JSON.stringify({ ...rest, [route.patch]: makePatch(base, value) });
  return patched.length < (body as string).length ? patched : null;
}

/** The whole request, the one sent when no patch is (or can be) used. A
 *  request too big to carry its base loses it, which only turns off the
 *  server's merge (it stores the value as sent, as before patches). */
export function wholeBody(method: string | undefined, path: string, body: BodyInit | null | undefined): BodyInit | null | undefined {
  const route = routeOf(method, path);
  if (!route?.dropsBaseWhenTooBig || typeof body !== "string" || new TextEncoder().encode(body).length <= BASE_BUDGET_BYTES) return body;
  const fields = parseFields(body);
  if (!fields) return body;
  const { [route.base]: _base, ...rest } = fields;
  return JSON.stringify(rest);
}

/** The server cannot give back the base a patch names. */
export const isPatchBaseUnknown = (error: unknown): boolean => error instanceof ApiError && error.status === 409 && error.code === "patch_base_unknown";
