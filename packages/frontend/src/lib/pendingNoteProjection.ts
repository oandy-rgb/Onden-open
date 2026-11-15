import type { ContentNode } from "./api";
import type { PendingWrite } from "./localDb";
// The slug entry point, not the package root: this runs inside the local-DB
// worker, and the root pulls in micromark, whose browser build touches
// `document` on load and kills the worker (test/workerImports.test.ts).
import { slugify } from "@onden/markdown/slug";
import { targetIds, targetsEntity } from "./pendingWriteTargets";

/** The note a write changes, creates or deletes as a whole (not one of its
 *  parts: attributes, tasks, tags …), or null. */
function wholeNote(write: PendingWrite): string | null {
  return targetIds(write, "node").find(id => targetsEntity(write, "node", id)) ?? null;
}

function bodyOf(write: PendingWrite): Record<string, unknown> | null {
  if (!write.body) return null;
  try {
    const body: unknown = JSON.parse(write.body);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; } // Invalid input stays queued for the server to classify.
}

/** Project still-pending node text onto a read-policy-filtered response.
 * Only supplied nodes remain visible; request references never grant access.
 * Input must be active pending rows in replay order. This does not replay
 * structural changes, attributes or other domains' operations. */
export function projectPendingNoteText(nodes: ContentNode[], writes: PendingWrite[]): ContentNode[] {
  const textById = new Map<string, Partial<Pick<ContentNode, "title" | "markdown">>>();
  for (const write of writes) {
    if (write.method !== "PATCH") continue;
    const id = wholeNote(write);
    if (id === null) continue;
    const body = bodyOf(write);
    if (!body) continue;
    const text = textById.get(id) ?? {};
    if (typeof body.title === "string") text.title = body.title;
    if (typeof body.markdown === "string") text.markdown = body.markdown;
    textById.set(id, text);
  }
  return nodes.map(node => {
    const text = textById.get(node.id);
    return text ? { ...node, ...text,
      ...(text.markdown !== undefined ? { body_len: text.markdown.length } : {}),
    } : node;
  });
}

/** Reconstruct absent, still-pending notes from the user's durable create input.
 * This never retains a cached row or its metadata/relations and is not a read
 * permission. Supplied nodes remain the authorized/cached projection. Later
 * queued text edits apply in replay order; a queued delete hides the creation.
 * Only the existing note writer's content/canvas creation contract is decoded. */
export function missingPendingNoteCreations(nodes: Pick<ContentNode, "id">[], writes: PendingWrite[]): ContentNode[] {
  const created = new Map<string, ContentNode>();
  for (const write of writes) {
    const body = bodyOf(write);
    const id = wholeNote(write);
    if (id === null) continue;
    if (write.method === "POST") {
      // The note writer's create. Other creates (a duplicate, a saved feed
      // item) carry no text, fail this contract and are not shown.
      if (!body || body.id !== id || typeof body.title !== "string") continue;
      if (body.source_type !== undefined && body.source_type !== "manual") continue;
      const nodeType = body.node_type ?? "content";
      if (nodeType !== "content" && nodeType !== "canvas") continue;
      if (body.markdown !== undefined && typeof body.markdown !== "string") continue;
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      created.set(id, { id, title: body.title, markdown, body_len: markdown.length,
        slug: slugify(body.title), source_type: "manual", node_type: nodeType });
      continue;
    }
    if (write.method === "DELETE") { created.delete(id); continue; }
    const note = created.get(id);
    if (write.method !== "PATCH" || !note || !body) continue;
    if (typeof body.title === "string") note.title = body.title;
    if (typeof body.markdown === "string") { note.markdown = body.markdown; note.body_len = body.markdown.length; }
  }
  const present = new Set(nodes.map(node => node.id));
  return [...created.values()].filter(node => !present.has(node.id));
}
