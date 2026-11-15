// A fake server, transport and local database for driving the REAL whiteboard
// write path (canvasWriter → writeLifecycle → writeQueue) through sequences
// chosen by a test (test/properties/canvasWriter.property.test.ts).
//
// Like helpers/saveWorld.ts it imports no app module (only types): the test
// mocks lib/api and lib/localDb with this world. The queue tables of the local
// database are saveWorld's, so both property suites fake the queue the same way.
//
// The server applies PATCH /api/boards/:id as backend/src/services/boardWrites.ts
// documents it: per card the later write wins; a card of a note in the trash is
// neither written nor removed (and is not listed); sections merge by id.
// canvasBoard.property.integration.test.ts runs that rule against the real
// routes; this world is only as faithful as that test says it is.

import type { Canvas, CanvasData, CanvasNodeEntry, CanvasSection } from "../../lib/api";
import type { BoardCardPatch, BoardSectionPatch } from "@onden/contract";
import { SaveWorld } from "./saveWorld";

type Changes = {
  cards?: { upsert?: BoardCardPatch[]; remove?: string[] };
  sections?: { upsert?: BoardSectionPatch[]; remove?: string[] };
};
export type FailureMode = "network" | "503" | "lost" | "reject";

/** The card as the server stores and returns it: unset optional fields omitted. */
export function canonCard(c: CanvasNodeEntry): CanvasNodeEntry {
  return {
    nodeId: c.nodeId, x: c.x, y: c.y,
    ...(c.width != null ? { width: c.width } : {}),
    ...(c.height != null ? { height: c.height } : {}),
    ...(c.color != null ? { color: c.color } : {}),
    ...(c.folded ? { folded: true } : {}),
    ...(c.subCanvasId != null ? { subCanvasId: c.subCanvasId } : {}),
  };
}
/** The server's rule for a card on the wire: the fields it names change (null clears one); a card
 *  the server lacks is created only when the patch has x and y. */
export function applyCardPatch(old: CanvasNodeEntry | undefined, patch: BoardCardPatch): CanvasNodeEntry | undefined {
  if (!old && (patch.x === undefined || patch.y === undefined)) return undefined;
  const next: Record<string, unknown> = { ...(old ?? { nodeId: patch.nodeId }) };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else if (value !== undefined) next[key] = value; }
  return canonCard(next as CanvasNodeEntry);
}
export const canonSection = (s: CanvasSection): CanvasSection => ({
  id: s.id, x: s.x, y: s.y, width: s.width, height: s.height, title: s.title, ...(s.color != null ? { color: s.color } : {}),
});

/** The server's rule for a frame on the wire (services/boardWrites mergeSections): the fields it names change (a null
 *  colour clears it); a frame the server lacks is created only when the patch has x, y, width and height. */
export function applySectionPatch(old: CanvasSection | undefined, patch: BoardSectionPatch): CanvasSection | undefined {
  const next: Record<string, unknown> = { ...old };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else if (value !== undefined) next[key] = value; }
  if (!old && ["x", "y", "width", "height"].some((key) => typeof next[key] !== "number")) return undefined;
  return canonSection(next as CanvasSection);
}

export class CanvasWorld {
  readonly queue = new SaveWorld();
  makeApiError: (status: number) => Error = (status) => new Error(`HTTP ${status}`);

  canvasId = "";
  title = "Board";
  /** Notes in the trash. */
  trashed = new Set<string>();
  cards = new Map<string, CanvasNodeEntry>();
  sections = new Map<string, CanvasSection>();
  requests: Array<{ method: string; path: string; body: Changes | null; idemKey: string | null }> = [];
  /** The next request fails this way (a lost response is applied, then fails;
   *  reject is a permanent 422, never applied). */
  failNext: FailureMode | null = null;
  private idem = new Map<string, unknown>();
  /** The whiteboard tab's layout_config as the server holds it (PATCH /api/nodes/:id/views/:viewId). */
  viewConfig: Record<string, unknown> = {};
  /** The connection is down for view changes: they fail as a network error and are not applied. */
  viewsDown = false;

  // local database: the canvas mirror
  mirror = new Map<string, { id: string; title: string; created_at?: string | null; updated_at?: string | null; data?: CanvasData | null }>();
  mirrorWrites = 0;

  reset(canvasId: string): void {
    this.queue.reset();
    this.canvasId = canvasId;
    this.trashed.clear(); this.cards.clear(); this.sections.clear();
    this.requests = []; this.failNext = null; this.idem.clear(); this.viewConfig = {}; this.viewsDown = false;
    this.mirror.clear(); this.mirrorWrites = 0;
  }

  /** What GET shows: stored cards of notes that are not in the trash. */
  visible(): CanvasData {
    return {
      nodes: [...this.cards.values()].filter((c) => !this.trashed.has(c.nodeId)).map(canonCard),
      sections: [...this.sections.values()].map(canonSection),
    };
  }

  applyChanges(changes: Changes): void {
    const upserted = new Set<string>();
    for (const card of changes.cards?.upsert ?? []) {
      if (this.trashed.has(card.nodeId)) continue;
      const next = applyCardPatch(this.cards.get(card.nodeId), card);
      if (next) this.cards.set(card.nodeId, next);
      upserted.add(card.nodeId);
    }
    for (const id of changes.cards?.remove ?? []) {
      if (!this.trashed.has(id) && !upserted.has(id)) this.cards.delete(id);
    }
    for (const id of changes.sections?.remove ?? []) this.sections.delete(id);
    for (const s of changes.sections?.upsert ?? []) {
      const next = applySectionPatch(this.sections.get(s.id), s);
      if (next) this.sections.set(s.id, next);
    }
  }

  /** The server's rule for a view change (services/functionRefs.ts patchView): a whole `layout_config` replaces,
   *  `layout_config_patch` sets the named keys of what is there NOW and removes those sent as null. */
  applyViewChanges(body: { layout_config?: Record<string, unknown>; layout_config_patch?: Record<string, unknown> }): void {
    if (body.layout_config) this.viewConfig = { ...body.layout_config };
    for (const [key, value] of Object.entries(body.layout_config_patch ?? {})) {
      const next = { ...this.viewConfig };
      if (value === null) delete next[key]; else next[key] = value;
      this.viewConfig = next;
    }
  }

  // ── transport (lib/api `api`) ──
  async transport(path: string, init: { method?: string; body?: unknown; headers?: unknown } = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) as Changes : null;
    const idemKey = headers["Idempotency-Key"] ?? null;
    this.requests.push({ method, path, body, idemKey });
    if (method === "POST" && path === "/api/canvases") {
      const created = JSON.parse(String(init.body)) as { id: string; title: string };
      this.canvasId = created.id;
      this.title = created.title;
      return { id: created.id, title: created.title, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
    }
    if (method === "GET" && path === `/api/canvases/${this.canvasId}`) {
      return structuredClone({ id: this.canvasId, title: this.title, created_at: "", updated_at: "", data: this.visible() } satisfies Canvas);
    }
    if (method === "PATCH" && path === `/api/boards/${this.canvasId}`) {
      const failure = this.failNext;
      this.failNext = null;
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "503") throw this.makeApiError(503);
      if (failure === "reject") throw this.makeApiError(422);
      if (!(idemKey && this.idem.has(idemKey))) {
        this.applyChanges(body ?? {});
        if (idemKey) this.idem.set(idemKey, true);
      }
      if (failure === "lost") throw new TypeError("Failed to fetch");
      return { id: this.canvasId, cards: body?.cards?.upsert?.length ?? 0, removed: body?.cards?.remove?.length ?? 0 };
    }
    if (method === "PATCH" && /^\/api\/nodes\/[^/]+\/views\/[^/]+$/.test(path)) {
      const failure = this.failNext;
      this.failNext = null;
      if (this.viewsDown || failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "503") throw this.makeApiError(503);
      if (failure === "reject") throw this.makeApiError(422);
      if (!(idemKey && this.idem.has(idemKey))) {
        this.applyViewChanges(JSON.parse(String(init.body)) as { layout_config?: Record<string, unknown>; layout_config_patch?: Record<string, unknown> });
        if (idemKey) this.idem.set(idemKey, true);
      }
      if (failure === "lost") throw new TypeError("Failed to fetch");
      return { updated: true };
    }
    throw new Error(`canvasWorld: unexpected request ${method} ${path}`);
  }

  // ── lib/localDb fake ──
  readonly localDb = {
    ...this.queue.localDb,
    catchUpWithOtherTabs: async () => {},
    upsertCanvas: async (c: { id: string; title: string; created_at?: string | null; updated_at?: string | null; data?: CanvasData | null }) => {
      this.mirrorWrites++;
      this.mirror.set(c.id, structuredClone(c));
    },
    removeCanvas: async (id: string) => { this.mirror.delete(id); },
    loadCanvas: async (id: string) => {
      const row = this.mirror.get(id);
      return row ? structuredClone({ created_at: "", updated_at: "", data: { nodes: [] }, ...row }) : null;
    },
    loadCanvases: async () => [...this.mirror.values()].map((r) => ({ id: r.id, title: r.title, created_at: r.created_at ?? "", updated_at: r.updated_at ?? "" })),
    putCanvasMemberships: async () => {},
  };
}

export const canvasWorld = new CanvasWorld();
