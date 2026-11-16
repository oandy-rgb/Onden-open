// Old frontend, new backend — the READ side. A tab left open across deploys
// keeps its release's decoders: it asks for /api/bootstrap in the wire format
// its code names (X-Onden-Bootstrap), decodes it with its own
// decodeBootstrapWire, and folds /api/sync deltas into its store with its own
// applySyncDelta. This runs each kept release's copy of those functions
// (fixtures/client-writes/<commit>/decoders, copied out by
// `npm run capture:client-writes -- <commit>`) on THIS backend's answers for a
// seeded workspace and compares what they produce with what the current
// frontend source produces from the same answers.
//
// Keep the last N production releases (see clientWritesReplay.integration.test.ts
// for the rule); both tests read the same fixture directories.
//
// Passing means: no decoder throws, and the notes (ids, titles, bodies, tree,
// spaces, tags, attributes), edges, tasks, tag catalog, workspace row and the
// permission flags the bootstrap carries come out the same as the current
// decoder's. Differences that are real are listed in KNOWN_DIFFERENCES with the
// field and the suggested fix, and run as `it.fails`.
//
// NOT covered, so nobody reads this as more than it is: the local DB worker
// (localDb applySync resolves a delta into the "applied" form before
// applySyncDelta sees it — here the raw delta is fed in directly, which is the
// same shape except `replace_for`/pendingCreations), the membership paging
// endpoints, and what each screen does with a field once decoded.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "./helpers/clientSkewWorkspace.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
vi.mock("../db.js", async (original) => ({
  ...await original<typeof import("../db.js")>(),
  getWorkspaceId: async () => (await import("./helpers/clientSkewWorkspace.js")).skew.workspaceId,
}));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => { const { skew } = await import("./helpers/clientSkewWorkspace.js"); return skew.user ? { user: skew.user } : null; }) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { seedWorkspace } = await import("./helpers/clientSkewWorkspace.js");

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "fixtures/client-writes");
const LIVE_SRC = resolve(here, "../../../frontend/src");

type Decoders = {
  short: string; subject: string; committedAt: string;
  wire: { decodeBootstrapWire: (data: any) => any; BOOTSTRAP_HEADER_VALUE: string };
  ops: { applySyncDelta: (prev: any, delta: any) => any };
};

/** `variable` specifier on purpose: these are other packages' sources, not part of this project's type-check. */
const load = (file: string): Promise<any> => import(/* @vite-ignore */ file);

async function releaseDecoders(): Promise<Decoders[]> {
  const found: Decoders[] = [];
  for (const entry of existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR, { withFileTypes: true }) : []) {
    const dir = join(FIXTURE_DIR, entry.name, "decoders/lib/data");
    if (!entry.isDirectory() || !existsSync(join(dir, "bootstrapWire.ts")) || !existsSync(join(dir, "storeOps.ts"))) continue;
    const release = JSON.parse(readFileSync(join(FIXTURE_DIR, entry.name, "release.json"), "utf8")) as { subject: string; committed_at: string };
    found.push({ short: entry.name, subject: release.subject, committedAt: release.committed_at, wire: await load(join(dir, "bootstrapWire.ts")), ops: await load(join(dir, "storeOps.ts")) });
  }
  return found.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
}

/**
 * Real differences found: `<short commit> <check>` → what differs and the fix.
 * Each runs as `it.fails`; delete the entry when the difference is gone.
 */
const KNOWN_DIFFERENCES: Record<string, string> = {};

/** syncEngine.fetchBootstrap's second step (private there): rebuild each note's attrs map from the typed rows. */
function withAttrsFromRows(data: any): any {
  if (data.attrs_omitted !== true) return data;
  const byNode = new Map<string, Record<string, string>>();
  for (const row of data.attributes ?? []) {
    const attrs = byNode.get(row.node_id);
    if (attrs) attrs[row.key] = row.value; else byNode.set(row.node_id, { [row.key]: row.value });
  }
  return { ...data, nodes: data.nodes.map((node: any) => ({ ...node, attrs: byNode.get(node.id) ?? {} })) };
}

const sorted = <T>(rows: T[] | undefined, key: (row: T) => string) => [...(rows ?? [])].sort((a, b) => key(a).localeCompare(key(b)));

/** What a person sees of the store: the fields screens read, order-free. */
function view(store: any) {
  const note = (n: any) => ({
    id: n.id, title: n.title, slug: n.slug, markdown: n.markdown, body_len: n.body_len ?? null, node_type: n.node_type, source_type: n.source_type,
    parent_id: n.parent_id ?? null, hidden: n.hidden ?? false, order_key: n.order_key ?? "", order_stamp: n.order_stamp ?? "", space_id: n.space_id ?? null,
    deleted_at: n.deleted_at ?? null, tag_color: n.tag_color ?? null,
    class_tag_ids: [...(n.class_tag_ids ?? [])].sort(), label_tag_ids: [...(n.label_tag_ids ?? [])].sort(),
    attrs: n.attrs ?? {},
  });
  return {
    notes: sorted(store.nodes, (n: any) => n.id).map(note),
    edges: sorted(store.edges, (e: any) => e.id),
    tasks: sorted(store.tasks, (t: any) => t.id),
    tags: sorted(store.tags, (t: any) => t.id),
    workspace: store.workspace ?? null,
    permissions: { actor_is_owner: store.actor_is_owner ?? null, can_review: store.can_review ?? null },
  };
}

/** Exact differences between two views: `path: old → current`. */
function differences(old: unknown, current: unknown, path = ""): string[] {
  if (JSON.stringify(old) === JSON.stringify(current)) return [];
  if (Array.isArray(old) && Array.isArray(current) && old.length === current.length) return old.flatMap((o, i) => differences(o, current[i], `${path}[${i}]`));
  if (old && current && typeof old === "object" && typeof current === "object" && !Array.isArray(old) && !Array.isArray(current)) {
    return [...new Set([...Object.keys(old), ...Object.keys(current)])].flatMap((k) => differences((old as any)[k], (current as any)[k], `${path}.${k}`));
  }
  return [`${path}: ${JSON.stringify(old)} → ${JSON.stringify(current)}`];
}

const releases = await releaseDecoders();

describe.skipIf(!isTestDb)("old frontend decoders on the current backend's answers", () => {
  let run: Run;
  let live: { wire: Decoders["wire"]; ops: Decoders["ops"] };
  const answers = new Map<string, any>();

  /** The bootstrap as a client naming `header` is served (none: the lean-less shape). */
  const bootstrapFor = async (header: string | null, query = "") => {
    const key = `${header}|${query}`;
    if (!answers.has(key)) {
      const res = await run.call("GET", `/api/bootstrap${query}`, undefined, header ? { "x-onden-bootstrap": header } : {});
      expect(res.status).toBe(200);
      answers.set(key, res.json);
    }
    return answers.get(key);
  };

  beforeAll(async () => {
    live = { wire: await load(join(LIVE_SRC, "lib/data/bootstrapWire.ts")), ops: await load(join(LIVE_SRC, "lib/data/storeOps.ts")) };
    const newest = JSON.parse(readFileSync(join(FIXTURE_DIR, releases.at(-1)!.short, "writes.json"), "utf8")) as { ids: Record<string, string> };
    run = await seedWorkspace(newest.ids);
    // Something for the delta to say beyond creation: an edit, a delete, a tag.
    const id = run.ids();
    await run.seed("PATCH", `/api/nodes/${id.alpha}`, { title: "Alpha edited" });
    await run.seed("DELETE", `/api/nodes/${id.beta}`);
    await run.seed("PUT", `/api/nodes/${id.alpha}/tags/${id.tag2}`, {});
  }, 60_000);

  it("kept at least two releases, with their decoders", () => {
    expect(releases.length).toBeGreaterThanOrEqual(2);
  });

  for (const query of ["", "?bodies=none"]) {
    it(`the current decoder reads its own bootstrap${query ? ` (${query})` : ""}`, async () => {
      const raw = await bootstrapFor(live.wire.BOOTSTRAP_HEADER_VALUE, query);
      const store = withAttrsFromRows(live.wire.decodeBootstrapWire(structuredClone(raw)));
      expect(store.nodes.length).toBeGreaterThan(5);
      expect(store.nodes.find((n: any) => n.title === "Alpha edited")?.attrs?.status).toBe("draft");
    });
  }

  for (const rel of releases) describe(`release ${rel.short} — ${rel.subject}`, () => {
    for (const query of ["", "?bodies=none"]) {
      const check = `bootstrap${query ? " (bodies=none)" : ""}`;
      it(`${check}: decodes and matches the current decoder`, async () => {
        const raw = await bootstrapFor(rel.wire.BOOTSTRAP_HEADER_VALUE, query);
        const old = view(withAttrsFromRows(rel.wire.decodeBootstrapWire(structuredClone(raw))));
        const current = view(withAttrsFromRows(live.wire.decodeBootstrapWire(structuredClone(await bootstrapFor(live.wire.BOOTSTRAP_HEADER_VALUE, query)))));
        expect(old.notes.length, "the seeded notes came through").toBeGreaterThan(5);
        const diff = differences(old, current);
        const known = KNOWN_DIFFERENCES[`${rel.short} ${check}`];
        if (known) expect(diff, known).not.toEqual([]);
        else expect(diff).toEqual([]);
      });
    }
    it("sync delta: folds into the store the same way", async () => {
      const raw = await bootstrapFor(rel.wire.BOOTSTRAP_HEADER_VALUE);
      const delta = (await run.call("POST", "/api/sync", { since: 0 })).json;
      expect(delta.last_event_id).toBeDefined();
      const empty = (decode: Decoders["wire"]) => ({ ...withAttrsFromRows(decode.decodeBootstrapWire(structuredClone(raw))), nodes: [], edges: [], tasks: [] });
      const old = view(rel.ops.applySyncDelta(empty(rel.wire), structuredClone(delta)));
      const current = view(live.ops.applySyncDelta(empty(live.wire), structuredClone(delta)));
      expect(old.notes.length, "the delta carried the seeded workspace").toBeGreaterThan(4);
      const diff = differences(old, current);
      const known = KNOWN_DIFFERENCES[`${rel.short} sync delta`];
      if (known) expect(diff, known).not.toEqual([]);
      else expect(diff).toEqual([]);
    });
  });
});
