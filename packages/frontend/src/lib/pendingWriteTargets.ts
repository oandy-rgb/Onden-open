// What a queued write acts on, decided once when it is queued (D45). Readers
// (slim paint, body download/forget, edge replace, note projection, agenda,
// boards, draft outcome) ask writeTargets() instead of parsing paths. Loaded by
// the local-DB worker: no imports, nothing that needs a DOM.

/** One entity a write acts on. `part` names a sub-resource of it (attributes,
 *  tasks, tags/<id>, …); absent, the write is on the entity itself — its create
 *  (POST to the collection, id in the body), change or delete. */
export type WriteTarget = { kind: WriteTargetKind; id: string; part?: string };
export type WriteTargetKind = "node" | "edge" | "canvas" | "board" | "task" | "tag" | "pointer";

/** A queued (or recovered) request, with the targets recorded for it if any. */
export type TargetedWrite = { method: string; path: string; body?: string | null; targets?: WriteTarget[] | null };

const FAMILIES = new Map<string, WriteTargetKind>([
  ["nodes", "node"], ["edges", "edge"], ["canvases", "canvas"], ["boards", "board"], ["tasks", "task"], ["tags", "tag"], ["pointers", "pointer"],
]);
const KINDS = new Set<string>(FAMILIES.values());

/** The write's targets: those recorded when it was queued, else decoded from
 *  its request (rows queued before targets were recorded, recovery copies). */
export function writeTargets(write: TargetedWrite): WriteTarget[] {
  return write.targets ?? decodeWriteTargets(write);
}

/** Ids of every `kind` entity the write acts on, itself or a part of it. */
export function targetIds(write: TargetedWrite, kind: WriteTargetKind): string[] {
  return writeTargets(write).filter(target => target.kind === kind).map(target => target.id);
}

/** The write acts on this entity itself (not one of its parts). */
export function targetsEntity(write: TargetedWrite, kind: WriteTargetKind, id: string): boolean {
  return writeTargets(write).some(target => target.kind === kind && target.id === id && target.part === undefined);
}

/** Ids of entities whose create request is still queued (POST naming the entity
 *  itself, not a part of it). The server cannot know them yet, so a membership
 *  check that finds them unreadable has nothing to say about them. */
export function pendingCreateIds(writes: TargetedWrite[]): Set<string> {
  const ids = new Set<string>();
  for (const write of writes) {
    if (write.method !== "POST") continue;
    for (const target of writeTargets(write)) if (target.part === undefined) ids.add(target.id);
  }
  return ids;
}

/** `ids` minus those whose create is still queued. */
export function withoutPendingCreates(ids: string[], writes: TargetedWrite[]): string[] {
  const queued = pendingCreateIds(writes);
  return ids.filter((id) => !queued.has(id));
}

/** Stored form of recorded targets; null keeps the row on the decoding path. */
export function parseStoredTargets(raw: string | null | undefined): WriteTarget[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isTarget) ? parsed : undefined;
  } catch { return undefined; }
}

function isTarget(value: unknown): value is WriteTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return typeof target.kind === "string" && KINDS.has(target.kind) && typeof target.id === "string"
    && (target.part === undefined || typeof target.part === "string");
}

/** The one reading of the API's write paths: /api/<family>[/<id>[/<part>…]].
 *  A create names its new id in the body; a few sub-resources create another
 *  entity (a task on a node, a duplicate, a saved feed item). Anything else —
 *  and a body that is not JSON — yields only what the path says. */
function decodeWriteTargets(write: TargetedWrite): WriteTarget[] {
  const segments = write.path.split(/[?#]/, 1)[0]!.split("/");
  if (segments[0] !== "" || segments[1] !== "api") return [];
  const decoded: string[] = [];
  for (const segment of segments.slice(2)) {
    try { decoded.push(decodeURIComponent(segment)); } catch { return []; }
  }
  const [family, id, ...rest] = decoded;
  const created = bodyId(write.body, family === "rss" ? "node_id" : "id");
  if (family === "rss") {
    // POST /api/rss/items/<item>/save mints the note it saves into.
    return id === "items" && rest.length === 2 && rest[1] === "save" && created ? [{ kind: "node", id: created }] : [];
  }
  const kind = family === undefined ? undefined : FAMILIES.get(family);
  if (!kind) return [];
  if (!id) return write.method === "POST" && created ? [{ kind, id: created }] : [];
  const part = rest.length ? rest.join("/") : undefined;
  const targets: WriteTarget[] = [part === undefined ? { kind, id } : { kind, id, part }];
  if (kind === "node" && write.method === "POST" && created) {
    if (part === "tasks") targets.push({ kind: "task", id: created });
    if (part === "duplicate") targets.push({ kind: "node", id: created });
  }
  return targets;
}

function bodyId(body: string | null | undefined, field: string): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : undefined;
    return typeof value === "string" && value ? value : null;
  } catch { return null; } // Invalid input stays queued for the server to classify.
}
