// A request too big to send whole, made small again on what the server stores now (docs/research/scan-2026-11-14/09-ink-pdf.md M1).
// Loaded only when a patch's base is unknown AND the whole request does not fit (lib/data/writeQueue.ts): the merge libraries
// stay out of the boot bundle.
import { UUID_SOURCE, INK_PAGE_ATTRS } from "@onden/markdown";
import { api } from "../api";
import { bodyPatchedAgainst, parseFields, routeOf } from "./patchedBody";

const ATTRIBUTE_PATH = new RegExp(`^/api/nodes/(${UUID_SOURCE})/attributes/([a-z_]+)$`, "i");

/** A request too big to send whole, made small again on what the server stores now: the value read back, the writer's
 *  value merged into it the way the server merges (its base is the merge base), and the result sent as a patch against
 *  the stored text, which the server always has. Without it, such a request lost its base and the server stored the
 *  value as sent, so another device's strokes saved in between were overwritten (scan 09 M1). Null when it cannot be
 *  made (not a merged attribute, the server could not be read): the caller sends the request as before. */
export async function rebasedOnStored(method: string | undefined, path: string, body: BodyInit | null | undefined): Promise<string | null> {
  const route = routeOf(method, path);
  const fields = route?.dropsBaseWhenTooBig ? parseFields(body) : null;
  const target = ATTRIBUTE_PATH.exec(path);
  if (!route || !fields || !target) return null;
  const { value, base } = { value: fields[route.value], base: fields[route.base] };
  if (typeof value !== "string" || typeof base !== "string") return null;
  const key = target[2]!;
  try {
    const stored = ((await api<Array<{ key: string; value: string }>>(`/api/nodes/${target[1]}/attributes?keys=${encodeURIComponent(key)}`)).find((row) => row.key === key))?.value;
    if (typeof stored !== "string") return null;
    const merged = stored === base || stored === value ? value : await mergeAttributeValue(key, base, stored, value);
    if (merged === null) return null;
    return bodyPatchedAgainst(route, fields, stored, merged);
  } catch { return null; }
}

/** The merge the server runs for a mergeable attribute (services/attributeWrites.ts mergeAttribute); the libraries load only here. */
async function mergeAttributeValue(key: string, base: string, stored: string, incoming: string): Promise<string | null> {
  if (key === "page_text") return (await import("@onden/markdown/page-text")).mergePageText(base, stored, incoming).value;
  if (key === "page_images") return (await import("@onden/markdown/page-images")).mergePageImages(base, stored, incoming).value;
  // A drawing: the merge's value, as main always sent. When it leaves out the writer's version of something both changed,
  // that version is not recorded (the server never saw this request's base, so it cannot merge it with a conflict
  // record); sending the writer's value whole instead would replace what is stored and silently hide another device's
  // new strokes (PR #1783 review round 3) — worse. This path only runs for a request too big to send whole whose
  // patch base the server no longer has.
  if ((INK_PAGE_ATTRS as readonly string[]).includes(key)) return (await import("@onden/markdown/ink")).mergeInk(base, stored, incoming).value;
  return null;
}

