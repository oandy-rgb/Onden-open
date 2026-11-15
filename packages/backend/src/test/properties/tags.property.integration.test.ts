// Model-based random test of tags and functions (fc.commands) through the REAL
// routes, as the workspace owner, on a `*_test` database.
//
// Model (owner decisions): tags form ONE parent_id tree (hierarchy only); a tag
// can add functions by extending a module tag (tag_schema.extends); notes carry
// tags and fill field values; module tags never sit in the tag tree (409
// module_tag_parent); sibling names are unique; a merge moves the members of
// the source to the target.
//
// Commands: create tag (top level, child, or `#a/b` written in a note body),
// rename (also to a sibling's name; PATCH /api/nodes and /api/tags), move (also
// into its own subtree and under a module tag), delete / restore a tag, merge,
// add / remove a function, tag / untag a note, create / delete / restore /
// duplicate a note, set a field value, undo the last rename.
//
// Invariants, checked after EVERY command (verify below):
//   • the live tag tree has no cycle and no module tag in it
//   • sibling names are unique among live tags
//   • a refused command is a clean 4xx with a known code, never a 500, and
//     leaves the database exactly as it was
//   • tree, parent, name and liveness equal the model
//   • memberTagIds, the members of each tag, /api/query by name and the usage
//     counts of the tag catalog equal the model
//   • the frontend functions (lib/nodeTags.ts, lib/tagModules.ts) give the same
//     membership and abilities as the backend for the same state
//   • replaying structure_log's tag applications and removals gives the tags every note carries
//   • after a merge every member of the source (also one that is restored later)
//     carries the target; duplicating a note never fails because of a deleted
//     tag; removing a function keeps the field values
//
// Known review items #4 and #5 (docs/archive/research/review-2026-10-24/data-integrity.md)
// are fixed by PR fix/a2-structure-import-backup. Until that merges, each is pinned
// below as a named `it.fails`, and the random property leaves those situations
// out. PROPS_TAGS_KNOWN=include puts them back (the property then fails with the
// shrunk sequence). #20 does not reproduce through the routes (see its test).
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/tags.property.integration.test.ts
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { workspaceTagProblems } from "../helpers/structureReplay.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { q } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import nodesRouter from "../../routes/nodes.js";
import tagsRouter from "../../routes/tags.js";
import eventsRouter from "../../routes/events.js";
import queryRouter from "../../routes/query.js";
import workspaceRouter from "../../routes/workspace.js";
import { descendantsOf, memberTagIds } from "../../services/tagHierarchy.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { PROPS_RUNS, PROPS_SEED, checkAsync } from "../helpers/propsConfig.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

/** The two situations of the review (#4, #5) stay out of the random
 *  property until their fix lands; "include" puts them back. */
const INCLUDE_KNOWN = process.env.PROPS_TAGS_KNOWN === "include";
const FIX_PR = "fix/a2-structure-import-backup";
/** Default runs: small, so the file stays well under a minute. An explicit PROPS_RUNS wins. */
const DEFAULT_RUNS = 30;
const MAX_COMMANDS = 30;

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/events", eventsRouter);
app.route("/api/query", queryRouter);
app.route("/api/workspace", workspaceRouter);

// ── The real side ───────────────────────────────────────────────────────────

type Res = { status: number; body: Record<string, any> };

/** One real workspace per run: the owner, its module tags (functions) and a
 *  request helper. Tests make their own workspace and never touch another. */
type World = {
  ws: string;
  owner: ActorCtx;
  call: (method: string, path: string, json?: unknown) => Promise<Res>;
  /** module id → module tag id */
  modules: Record<string, string>;
};

// A view (calendar…) is a function reference of its tag or note since migration 188: no view module tag is made.
const MODULES = ["skills"] as const;

async function newWorld(): Promise<World> {
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Tag properties', $1) RETURNING id::text`,
    [`tag-properties-${randomUUID()}`])).rows[0]!.id;
  const owner = await persistActor(WS, { id: "tp-owner", name: "Owner", role: "admin", type: "human" });
  currentActor = owner;
  const call: World["call"] = async (method, path, json) => {
    const res = await app.request(path, {
      method, headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let body: Record<string, any> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { status: res.status, body };
  };
  const modules: Record<string, string> = {};
  // skills needs the ai module.
  expect((await call("PATCH", "/api/workspace/modules", { module: "ai", imported: true })).status).toBe(200);
  for (const module of MODULES) {
    const res = await call("PATCH", "/api/workspace/modules", { module, imported: true });
    if (res.status !== 200 || !res.body.module_tag_id) throw new Error(`module ${module}: ${res.status} ${JSON.stringify(res.body)}`);
    modules[module] = res.body.module_tag_id;
  }
  return { ws: WS, owner, call, modules };
}

// Frontend mirror, loaded from source (the two must give the same membership).
type FrontTag = { id: string; parent_id: string | null; schema_extends: string[]; view_module: boolean; schema_module: string | null; schema_behaviour: unknown; effective_modules?: string[]; functions?: Array<{ id: string; source_tag_id: string; ref_id: string | null }> };
type FrontNode = { id: string; node_type: string; class_tag_ids: string[]; label_tag_ids: string[]; hidden: boolean; deleted_at: string | null; source_type: string };
type FrontNodeTags = {
  tagMembers: (tags: FrontTag[], nodes: FrontNode[], tagId: string) => FrontNode[];
  tagMemberCounts: (tags: FrontTag[], nodes: FrontNode[]) => Map<string, number>;
  directTagUsage: (nodes: FrontNode[]) => Map<string, number>;
  memberTagIds: (tags: FrontTag[], tagId: string) => string[];
};
type FrontTagModules = { abilitySource: (tags: FrontTag[], tagId: string, module: string) => FrontTag | null };
let front: { nodeTags: FrontNodeTags; tagModules: FrontTagModules };
const frontendLib = (file: string): string => join(import.meta.dirname, "../../../../frontend/src/lib", file);

// ── The model ───────────────────────────────────────────────────────────────

type MTag = { id: string; name: string; parent: string | null; module: string | null; extends: string[]; deleted: boolean; group: number; groupRoot: boolean };
type MNote = { id: string; tags: Set<string>; deleted: boolean; venue: string | null; path: string[] | null };

/** A merge's promise: this note carries this tag (until someone untags it). */
type MergePromise = { noteId: string; tagId: string };

class Model {
  tags = new Map<string, MTag>();
  notes = new Map<string, MNote>();
  renames: Array<{ tagId: string; from: string; to: string; eventId: string }> = [];
  promises: MergePromise[] = [];
  groupSeq = 0;
  counter = 0;

  /** true: the review items (#4, #5) are held to their fixed behaviour (the pinned cases, PROPS_TAGS_KNOWN=include). */
  constructor(world: World, readonly fixed: boolean) {
    for (const [module, id] of Object.entries(world.modules)) {
      this.tags.set(id, { id, name: "", parent: null, module, extends: [], deleted: false, group: 0, groupRoot: false });
    }
  }
  fresh(prefix: string): string { return `${prefix}${++this.counter}`; }

  liveTags(): MTag[] {
    const live = [...this.tags.values()].filter((t) => !t.deleted);
    return [...live.filter((t) => !t.module), ...live.filter((t) => t.module)];
  }
  userTags(): MTag[] { return this.liveTags().filter((t) => !t.module); }
  moduleTags(): MTag[] { return this.liveTags().filter((t) => t.module); }
  deletedTags(): MTag[] { return [...this.tags.values()].filter((t) => t.deleted && !t.module); }
  liveNotes(): MNote[] { return [...this.notes.values()].filter((n) => !n.deleted); }

  liveChildren(id: string): MTag[] { return this.liveTags().filter((t) => t.parent === id); }
  descendants(id: string): string[] {
    const found: string[] = [];
    for (const queue = [id]; queue.length;) {
      for (const child of this.liveChildren(queue.shift()!)) { found.push(child.id); queue.push(child.id); }
    }
    return found;
  }
  pathOf(id: string): string {
    const names: string[] = [];
    for (let t = this.tags.get(id); t; t = t.parent ? this.tags.get(t.parent) : undefined) names.unshift(t.name);
    return names.join("/");
  }
  siblingNamed(parent: string | null, name: string, except?: string): MTag | undefined {
    return this.liveTags().find((t) => t.parent === parent && t.name === name && t.id !== except);
  }

  /** The one membership rule: the tag, its child tags and the tags extending it at any depth. */
  memberTags(id: string): string[] {
    const found = new Set([id]);
    for (const queue = [id]; queue.length;) {
      const at = queue.shift()!;
      for (const t of this.liveTags()) {
        if ((t.parent === at || t.extends.includes(at)) && !found.has(t.id)) { found.add(t.id); queue.push(t.id); }
      }
    }
    return [...found];
  }
  membersOf(tagId: string): string[] {
    const tags = new Set(this.memberTags(tagId));
    return this.liveNotes().filter((n) => [...n.tags].some((t) => tags.has(t))).map((n) => n.id).sort();
  }
  /** Notes carrying (directly) any live tag whose name is `name`, expanded by the membership rule. */
  membersNamed(name: string): string[] {
    const ids = new Set<string>();
    for (const t of this.liveTags()) if (!t.module && t.name.toLowerCase() === name.toLowerCase()) for (const id of this.membersOf(t.id)) ids.add(id);
    return [...ids].sort();
  }
  /** Module ids a tag provides: its own and what its extends / extended tags give. */
  abilities(tagId: string): Set<string> {
    const found = new Set<string>();
    const seen = new Set<string>();
    for (const queue = [tagId]; queue.length;) {
      const t = this.tags.get(queue.shift()!);
      if (!t || t.deleted || seen.has(t.id)) continue;
      seen.add(t.id);
      if (t.module) found.add(t.module);
      queue.push(...t.extends);
    }
    return found;
  }
  hasDeletedDirectTag(note: MNote): boolean { return [...note.tags].some((id) => this.tags.get(id)?.deleted); }
  /** A merge of `source` would skip a member that sits in the trash (review #4). */
  hasTrashedMember(source: string): boolean {
    return [...this.notes.values()].some((n) => n.deleted && n.tags.has(source));
  }
}

// ── Reading the real state ──────────────────────────────────────────────────

type RealTag = { id: string; title: string; parent_id: string | null; deleted: boolean; extends: string[]; module: string | null };

async function realTags(ws: string): Promise<RealTag[]> {
  return (await q<RealTag>(
    `SELECT id::text, title, parent_id::text, deleted_at IS NOT NULL AS deleted,
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(tag_schema->'extends') = 'array' THEN tag_schema->'extends' END)), '{}') AS extends,
            tag_schema->>'module' AS module
       FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' ORDER BY id`, [ws])).rows;
}
async function realNoteState(ws: string): Promise<Array<{ id: string; deleted: boolean; tags: string[]; venue: string | null }>> {
  return (await q<{ id: string; deleted: boolean; tags: string[]; venue: string | null }>(
    `SELECT n.id::text, n.deleted_at IS NOT NULL AS deleted,
            COALESCE(ARRAY(SELECT nt.tag_id::text FROM node_tags nt WHERE nt.node_id = n.id ORDER BY 1), '{}') AS tags,
            (SELECT a.value FROM node_attributes a WHERE a.node_id = n.id AND a.key = 'venue') AS venue
       FROM content_nodes n WHERE n.workspace_id = $1 AND n.node_type <> 'class_tag' ORDER BY n.id`, [ws])).rows;
}
/** Everything a refused command must leave untouched. */
async function snapshot(ws: string): Promise<string> {
  const events = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.n;
  return JSON.stringify({ tags: await realTags(ws), notes: await realNoteState(ws), events });
}

// ── Commands ────────────────────────────────────────────────────────────────

type Real = World;
type Cmd = fc.AsyncCommand<Model, Real>;

const NAMES = ["a", "b", "c", "d"] as const;
const name = fc.constantFrom(...NAMES);
const pick = fc.nat(1000);
const at = <T>(list: T[], i: number): T | undefined => (list.length ? list[i % list.length] : undefined);
const show = (value: unknown): string => JSON.stringify(value);

/** Refusals the routes may answer with: a 4xx and a JSON body naming the error. */
function refused(res: Res, what: string, codes?: string[]): void {
  expect(res.status, `${what}: expected a refusal, got ${res.status} ${show(res.body)}`).toBeGreaterThanOrEqual(400);
  expect(res.status, `${what}: server error ${show(res.body)}`).toBeLessThan(500);
  expect(typeof res.body.error, `${what}: refusal without a code ${show(res.body)}`).toBe("string");
  if (codes) expect(codes, `${what}: unknown refusal ${res.status} ${show(res.body)}`).toContain(res.body.error);
}
function ok(res: Res, what: string): void {
  expect(res.status, `${what}: expected success, got ${res.status} ${show(res.body)}`).toBeLessThan(300);
}

/** Run `act`, then hold the command to the shared rule: a refusal is clean and
 *  changes nothing; the caller applies the model only when it succeeded. */
/** What the runs exercised: "<command> ok|refused" → count, printed at the end so a green run shows its reach. */
const reach = new Map<string, number>();
async function attempt(real: Real, what: string, act: () => Promise<Res>, expected: { ok: true } | { refusedWith: string[] } | { either: string[] }): Promise<Res> {
  const before = await snapshot(real.ws);
  const res = await act();
  const succeeded = res.status < 300;
  const [verb = "", noun = ""] = what.split(" ");
  const kind = verb === "create" ? (noun === "a" ? "create note" : "create tag") : verb;
  const outcome = succeeded ? "ok" : `refused(${String(res.body.error).slice(0, 24)})`;
  reach.set(`${kind} ${outcome}`, (reach.get(`${kind} ${outcome}`) ?? 0) + 1);
  if ("ok" in expected) ok(res, what);
  else if ("refusedWith" in expected) refused(res, what, expected.refusedWith);
  else if (!succeeded) refused(res, what, expected.either);
  if (!succeeded) expect(await snapshot(real.ws), `${what}: a refused command changed the database`).toBe(before);
  return res;
}

class CreateTag implements Cmd {
  constructor(readonly nameValue: string, readonly parentPick: number | null) {}
  check = (m: Model) => this.parentPick === null || parentOf(m, this.parentPick) !== undefined;
  async run(m: Model, real: Real) {
    const parent = parentOf(m, this.parentPick) ?? undefined;
    const label = `create #${this.nameValue}${parent ? ` under ${m.pathOf(parent.id) || parent.module}` : ""}`;
    if (!parent) {
      const clash = m.siblingNamed(null, this.nameValue);
      const res = await attempt(real, label, () => real.call("POST", "/api/tags", { name: this.nameValue }),
        clash ? { refusedWith: ["tag_name_conflict"] } : { ok: true });
      if (!clash) m.tags.set(res.body.id, { id: res.body.id, name: this.nameValue, parent: null, module: null, extends: [], deleted: false, group: 0, groupRoot: false });
      return;
    }
    // A function's tag is addressed by the name it has (skills' tag is "skill"), not by the module's id: a path that
    // names no tag would make two plain tags instead of being refused.
    const parentPath = parent.module ? (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [parent.id])).rows[0]!.title : m.pathOf(parent.id);
    const path = `${parentPath}/${this.nameValue}`;
    if (parent.module) {
      await attempt(real, label, () => real.call("POST", "/api/tags/resolve-path", { path }), { refusedWith: ["module_tag_parent"] });
      return;
    }
    const existing = m.siblingNamed(parent.id, this.nameValue);
    const res = await attempt(real, label, () => real.call("POST", "/api/tags/resolve-path", { path }), { ok: true });
    if (!existing) {
      expect(res.body.created_ids, `${label}: one new tag expected`).toHaveLength(1);
      const id = res.body.created_ids[0] as string;
      m.tags.set(id, { id, name: this.nameValue, parent: parent.id, module: null, extends: [], deleted: false, group: 0, groupRoot: false });
    } else {
      expect(res.body.leaf_id, `${label}: the existing child is adopted`).toBe(existing.id);
    }
  }
  toString = () => `CreateTag(${show(this.nameValue)}, under=${show(this.parentPick)})`;
}

/** A body that writes `{a/b}` makes the tags of that path that are missing (services/blockNodes.ts):
 *  a note saved or copied with it re-creates a tag that was deleted or merged away since. */
async function savingWrittenPath(m: Model, real: Real, label: string, segments: string[], save: () => Promise<Res>): Promise<Res> {
  let parent: string | null = null;
  const missing: string[] = [];
  for (const segment of segments) {
    const found: MTag | undefined = m.siblingNamed(parent, segment);
    if (found) { parent = found.id; continue; }
    missing.push(segment);
    parent = "pending";
  }
  const before = new Set((await realTags(real.ws)).map((t) => t.id));
  const res = await attempt(real, label, save, { ok: true });
  const added = (await realTags(real.ws)).filter((t) => !before.has(t.id));
  expect(added.map((t) => t.title).sort(), `${label}: new tags`).toEqual([...missing].sort());
  let walk: string | null = null;
  for (const segment of segments) {
    const found: MTag | undefined = m.siblingNamed(walk, segment);
    if (found) { walk = found.id; continue; }
    const row = added.find((t) => t.title === segment && t.parent_id === walk);
    expect(row, `${label}: #${segment} created under its path parent`).toBeDefined();
    m.tags.set(row!.id, { id: row!.id, name: segment, parent: walk, module: null, extends: [], deleted: false, group: 0, groupRoot: false });
    walk = row!.id;
  }
  return res;
}

class CreateFromNoteBody implements Cmd {
  constructor(readonly segments: string[]) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const written = this.segments.join("/");
    const res = await savingWrittenPath(m, real, `note body writes {${written}}`, this.segments,
      () => real.call("POST", "/api/nodes", { title: m.fresh("n"), markdown: `## see {${written}}` }));
    m.notes.set(res.body.id, { id: res.body.id, tags: new Set(), deleted: false, venue: null, path: this.segments });
  }
  toString = () => `CreateFromNoteBody(#${this.segments.join("/")})`;
}

class RenameTag implements Cmd {
  constructor(readonly tagPick: number, readonly nameValue: string, readonly viaTagsRoute: boolean) {}
  check = (m: Model) => at(m.userTags(), this.tagPick)?.name !== this.nameValue && m.userTags().length > 0;
  async run(m: Model, real: Real) {
    const tag = at(m.userTags(), this.tagPick)!;
    const clash = m.siblingNamed(tag.parent, this.nameValue, tag.id);
    const label = `rename ${m.pathOf(tag.id)} to ${this.nameValue} via ${this.viaTagsRoute ? "/api/tags" : "/api/nodes"}`;
    const res = await attempt(real, label,
      () => this.viaTagsRoute ? real.call("PATCH", `/api/tags/${tag.id}`, { name: this.nameValue }) : real.call("PATCH", `/api/nodes/${tag.id}`, { title: this.nameValue }),
      clash ? { refusedWith: ["tag_name_conflict"] } : { ok: true });
    if (res.status < 300) {
      const eventId = (await q<{ id: string }>(
        `SELECT id::text FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'TAG_UPDATED' ORDER BY domain_events.id DESC LIMIT 1`,
        [real.ws, tag.id])).rows[0]!.id;
      m.renames.push({ tagId: tag.id, from: tag.name, to: this.nameValue, eventId });
      tag.name = this.nameValue;
    }
  }
  toString = () => `RenameTag(tag#${this.tagPick}, ${show(this.nameValue)}, via=${this.viaTagsRoute ? "tags" : "nodes"})`;
}

/** What a move answers when it is refused, by reason. */
const MOVE_REFUSAL = { module: "module_tag_parent", cycle: "parent_cycle", name: "tag_name_conflict" } as const;

/** Mostly user tags move; every fifth pick moves a module tag, which must stay at the top. */
const movable = (m: Model, pickValue: number): MTag | undefined => at(pickValue % 5 === 0 ? m.liveTags() : m.userTags(), pickValue);
const parentOf = (m: Model, parentPick: number | null): MTag | null | undefined => parentPick === null ? null : movable(m, parentPick);

class MoveTag implements Cmd {
  constructor(readonly tagPick: number, readonly parentPick: number | null) {}
  check = (m: Model) => {
    const tag = movable(m, this.tagPick);
    if (!tag) return false;
    const parent = parentOf(m, this.parentPick);
    return parent !== undefined && (parent?.id ?? null) !== tag.parent && parent?.id !== tag.id;
  };
  async run(m: Model, real: Real) {
    const tag = movable(m, this.tagPick)!;
    const parent = parentOf(m, this.parentPick)!;
    const label = `move ${m.pathOf(tag.id) || tag.module} under ${parent ? m.pathOf(parent.id) || parent.module : "the top level"}`;
    const reasons: string[] = [];
    if (parent && (tag.module || parent.module)) reasons.push(MOVE_REFUSAL.module);
    if (parent && m.descendants(tag.id).includes(parent.id)) reasons.push(MOVE_REFUSAL.cycle);
    if (m.siblingNamed(parent?.id ?? null, tag.name, tag.id) && !tag.module) reasons.push(MOVE_REFUSAL.name);
    await attempt(real, label, () => real.call("PATCH", `/api/nodes/${tag.id}`, { parent_id: parent?.id ?? null }),
      reasons.length ? { refusedWith: reasons } : { ok: true });
    if (!reasons.length) tag.parent = parent?.id ?? null;
  }
  toString = () => `MoveTag(tag#${this.tagPick}, under=${show(this.parentPick)})`;
}

class DeleteTag implements Cmd {
  constructor(readonly tagPick: number) {}
  check = (m: Model) => m.userTags().length > 0;
  async run(m: Model, real: Real) {
    const tag = at(m.userTags(), this.tagPick)!;
    const label = `delete ${m.pathOf(tag.id)}`;
    await attempt(real, label, () => real.call("DELETE", `/api/nodes/${tag.id}`), { ok: true });
    const group = ++m.groupSeq;
    for (const id of [tag.id, ...m.descendants(tag.id)]) { const t = m.tags.get(id)!; t.deleted = true; t.group = group; t.groupRoot = id === tag.id; }
  }
  toString = () => `DeleteTag(tag#${this.tagPick})`;
}

class RestoreTag implements Cmd {
  constructor(readonly tagPick: number) {}
  check = (m: Model) => m.deletedTags().length > 0;
  async run(m: Model, real: Real) {
    const tag = at(m.deletedTags(), this.tagPick)!;
    const label = `restore ${m.pathOf(tag.id)} (deleted in group ${tag.group})`;
    const res = await attempt(real, label, () => real.call("POST", `/api/nodes/${tag.id}/undelete`), { either: ["tag_name_conflict", "state_conflict"] });
    if (res.status >= 300) return;
    // What comes back (services/nodeTrash.ts restorePlan): the tag, the deleted
    // tags above it, and, when it is the one that was deleted, what went with it.
    const back = new Set([tag.id]);
    for (let above = tag.parent ? m.tags.get(tag.parent) : undefined; above; above = above.parent ? m.tags.get(above.parent) : undefined) {
      if (above.deleted) back.add(above.id);
    }
    if (tag.groupRoot) for (const t of m.tags.values()) if (t.deleted && t.group === tag.group) back.add(t.id);
    const rows = new Map((await realTags(real.ws)).map((t) => [t.id, t]));
    for (const t of m.tags.values()) {
      if (!t.deleted || t.module) continue;
      expect(!rows.get(t.id)!.deleted, `${label}: ${t.name} should ${back.has(t.id) ? "" : "not "}come back`).toBe(back.has(t.id));
      if (back.has(t.id)) t.deleted = false;
    }
  }
  toString = () => `RestoreTag(deleted#${this.tagPick})`;
}

class MergeTags implements Cmd {
  constructor(readonly sourcePick: number, readonly targetPick: number) {}
  check = (m: Model) => {
    const tags = m.userTags();
    if (tags.length < 2) return false;
    const source = at(tags, this.sourcePick)!;
    const target = this.target(m);
    if (source.id === target.id) return false;
    return m.fixed || !m.hasTrashedMember(source.id);
  };
  /** One pick in five may name a module tag: the preview and the merge refuse it, and the picker leaves it out. */
  private target = (m: Model) => at(this.targetPick % 5 === 0 ? m.liveTags() : m.userTags(), this.targetPick)!;
  async run(m: Model, real: Real) {
    const tags = m.userTags();
    const source = at(tags, this.sourcePick)!;
    const target = this.target(m);
    const label = `merge ${m.pathOf(source.id)} into ${target.module ? `module ${target.module}` : m.pathOf(target.id)}`;
    const reasons: string[] = [];
    // The preview refuses what the merge refuses for the target itself, with the same codes, and changes nothing.
    const targetRefusal = m.descendants(source.id).includes(target.id) ? ["merge_into_sub_tag"] : target.module ? ["merge_into_module_tag", "view_module_tag"] : [];
    await attempt(real, `preview ${label}`, () => real.call("GET", `/api/tags/${source.id}/merge-preview?target=${target.id}`),
      targetRefusal.length ? { refusedWith: targetRefusal } : { ok: true });
    reasons.push(...targetRefusal);
    const children = m.liveChildren(source.id);
    if (!targetRefusal.length && children.some((c) => m.siblingNamed(target.id, c.name))) reasons.push("sub_tag_name_conflict");
    const res = await attempt(real, label, () => real.call("POST", `/api/tags/${source.id}/merge`, { target_id: target.id }),
      reasons.length ? { refusedWith: reasons } : { ok: true });
    if (reasons.length) return;
    const movers = [...m.notes.values()].filter((n) => !n.deleted && n.tags.has(source.id));
    const gained = movers.filter((n) => !n.tags.has(target.id)).length;
    if (!m.fixed) expect(res.body.members_gained_target, `${label}: members that gained the target`).toBe(gained);
    // A member in the trash is a member too: it gets the target as well, so it has it when restored (review #4).
    for (const n of m.notes.values()) {
      if (n.tags.has(source.id) && (m.fixed || !n.deleted)) n.tags.add(target.id);
    }
    for (const p of m.promises) if (p.tagId === source.id) p.tagId = target.id;
    for (const n of m.notes.values()) if (n.tags.has(target.id) && n.tags.has(source.id) && (m.fixed || !n.deleted)) m.promises.push({ noteId: n.id, tagId: target.id });
    for (const c of children) c.parent = target.id;
    source.deleted = true;
    source.group = ++m.groupSeq;
    source.groupRoot = true;
  }
  toString = () => `MergeTags(source#${this.sourcePick} into target#${this.targetPick})`;
}

class AddFunction implements Cmd {
  constructor(readonly tagPick: number, readonly modulePick: number) {}
  check = (m: Model) => m.userTags().length > 0;
  async run(m: Model, real: Real) {
    const tag = at(m.userTags(), this.tagPick)!;
    const mod = at(m.moduleTags(), this.modulePick)!;
    const label = `add function ${mod.module} to ${m.pathOf(tag.id)}`;
    const next = [...new Set([...tag.extends, mod.id])];
    await attempt(real, label, () => real.call("PUT", `/api/tags/${tag.id}/extends`, { extends: next }), { ok: true });
    tag.extends = next;
  }
  toString = () => `AddFunction(tag#${this.tagPick}, module#${this.modulePick})`;
}

class RemoveFunction implements Cmd {
  constructor(readonly tagPick: number) {}
  check = (m: Model) => m.userTags().some((t) => t.extends.length > 0);
  async run(m: Model, real: Real) {
    const tag = at(m.userTags().filter((t) => t.extends.length > 0), this.tagPick)!;
    const dropped = tag.extends[0]!;
    const label = `remove function ${m.tags.get(dropped)?.module} from ${m.pathOf(tag.id)}`;
    const next = tag.extends.filter((id) => id !== dropped);
    await attempt(real, label, () => real.call("PUT", `/api/tags/${tag.id}/extends`, { extends: next }), { ok: true });
    tag.extends = next;
  }
  toString = () => `RemoveFunction(tag#${this.tagPick})`;
}

class CreateNote implements Cmd {
  constructor(readonly tagPick: number | null) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const tag = this.tagPick === null ? undefined : at(m.liveTags(), this.tagPick);
    const label = `create a note${tag ? ` with tag ${tag.name || tag.module}` : ""}`;
    const res = await attempt(real, label,
      () => real.call("POST", "/api/nodes", { title: m.fresh("n"), markdown: "x", ...(tag ? { tag_ids: [tag.id] } : {}) }), { ok: true });
    m.notes.set(res.body.id, { id: res.body.id, tags: new Set(tag ? [tag.id] : []), deleted: false, venue: null, path: null });
  }
  toString = () => `CreateNote(tag=${show(this.tagPick)})`;
}

class TagNote implements Cmd {
  constructor(readonly notePick: number, readonly tagPick: number) {}
  check = (m: Model) => m.notes.size > 0 && m.liveTags().length > 0;
  async run(m: Model, real: Real) {
    const note = at([...m.notes.values()], this.notePick)!;
    const tag = at(m.liveTags(), this.tagPick)!;
    const label = `tag note ${note.id.slice(0, 4)} with ${tag.name || tag.module}`;
    const res = await attempt(real, label, () => real.call("PUT", `/api/nodes/${note.id}/tags/${tag.id}`, {}),
      note.deleted ? { either: ["not found", "node not found", "tag not found"] } : { ok: true });
    if (res.status < 300) note.tags.add(tag.id);
    else expect(note.deleted, `${label}: refused although both are plain`).toBe(true);
  }
  toString = () => `TagNote(note#${this.notePick}, tag#${this.tagPick})`;
}

class UntagNote implements Cmd {
  constructor(readonly notePick: number) {}
  check = (m: Model) => [...m.notes.values()].some((n) => !n.deleted && [...n.tags].some((t) => m.tags.get(t) && !m.tags.get(t)!.deleted));
  async run(m: Model, real: Real) {
    const candidates = [...m.notes.values()].filter((n) => !n.deleted && [...n.tags].some((t) => !m.tags.get(t)!.deleted));
    const note = at(candidates, this.notePick)!;
    const tag = m.tags.get([...note.tags].find((t) => !m.tags.get(t)!.deleted)!)!;
    await attempt(real, `untag note ${note.id.slice(0, 4)} from ${tag.name || tag.module}`, () => real.call("DELETE", `/api/nodes/${note.id}/tags/${tag.id}`), { ok: true });
    note.tags.delete(tag.id);
    m.promises = m.promises.filter((p) => !(p.noteId === note.id && p.tagId === tag.id));
  }
  toString = () => `UntagNote(note#${this.notePick})`;
}

class DeleteNote implements Cmd {
  constructor(readonly notePick: number) {}
  check = (m: Model) => m.liveNotes().length > 0;
  async run(m: Model, real: Real) {
    const note = at(m.liveNotes(), this.notePick)!;
    await attempt(real, `delete note ${note.id.slice(0, 4)}`, () => real.call("DELETE", `/api/nodes/${note.id}`), { ok: true });
    note.deleted = true;
  }
  toString = () => `DeleteNote(note#${this.notePick})`;
}

class RestoreNote implements Cmd {
  constructor(readonly notePick: number) {}
  check = (m: Model) => [...m.notes.values()].some((n) => n.deleted);
  async run(m: Model, real: Real) {
    const note = at([...m.notes.values()].filter((n) => n.deleted), this.notePick)!;
    await attempt(real, `restore note ${note.id.slice(0, 4)}`, () => real.call("POST", `/api/nodes/${note.id}/undelete`), { ok: true });
    note.deleted = false;
  }
  toString = () => `RestoreNote(note#${this.notePick})`;
}

class DuplicateNote implements Cmd {
  constructor(readonly notePick: number) {}
  check = (m: Model) => {
    const live = m.liveNotes();
    return live.length > 0 && (m.fixed || !m.hasDeletedDirectTag(at(live, this.notePick)!));
  };
  async run(m: Model, real: Real) {
    const note = at(m.liveNotes(), this.notePick)!;
    const label = `duplicate note ${note.id.slice(0, 4)}${m.hasDeletedDirectTag(note) ? " (carries a deleted tag)" : ""}`;
    // A deleted tag never makes a copy fail: the copy carries the live tags (review #5).
    const duplicate = () => real.call("POST", `/api/nodes/${note.id}/duplicate`, {});
    const res = note.path ? await savingWrittenPath(m, real, label, note.path, duplicate) : await attempt(real, label, duplicate, { ok: true });
    m.notes.set(res.body.id, {
      id: res.body.id, deleted: false, venue: note.venue, path: note.path,
      tags: new Set([...note.tags].filter((t) => !m.tags.get(t)!.deleted)),
    });
  }
  toString = () => `DuplicateNote(note#${this.notePick})`;
}

const fieldNotes = (m: Model): MNote[] => m.liveNotes();

class SetField implements Cmd {
  constructor(readonly notePick: number, readonly value: string) {}
  check = (m: Model) => m.liveNotes().length > 0;
  async run(m: Model, real: Real) {
    const note = at(fieldNotes(m), this.notePick)!;
    await attempt(real, `set venue of note ${note.id.slice(0, 4)} to ${this.value}`,
      () => real.call("PUT", `/api/nodes/${note.id}/attributes/venue`, { value: this.value }), { ok: true });
    note.venue = this.value;
  }
  toString = () => `SetField(note#${this.notePick}, venue=${show(this.value)})`;
}

class UndoRename implements Cmd {
  check = (m: Model) => {
    const last = m.renames.at(-1);
    return !!last;
  };
  async run(m: Model, real: Real) {
    const last = m.renames.pop()!;
    const tag = m.tags.get(last.tagId)!;
    const label = `undo the rename ${last.from} → ${last.to}`;
    // The old name taken by a live sibling: review #20 says this is a 500; through the routes it is a clean state_conflict.
    const collides = !tag.deleted && !!m.siblingNamed(tag.parent, last.from, tag.id);
    const res = await attempt(real, label, () => real.call("POST", `/api/events/${last.eventId}/restore`, {}),
      { either: ["state_conflict", "target_gone"] });
    // A later rename of the same tag is an edit the undo must not overwrite.
    const stale = tag.name !== last.to;
    if (collides || stale) expect(res.status, `${label}: ${collides ? "the old name is taken" : "the tag was renamed again"}, so the undo must be refused`).toBeGreaterThanOrEqual(400);
    else if (res.status < 300) {
      expect((await realTags(real.ws)).find((t) => t.id === tag.id)!.title, `${label}: the old name is back`).toBe(last.from);
      tag.name = last.from;
    }
  }
  toString = () => "UndoRename()";
}

class SettleOnNothing implements Cmd { // keeps fc.commands from needing a non-empty arbitrary list
  check = () => true;
  async run() {}
  toString = () => "Noop()";
}

const createTag = fc.tuple(name, fc.option(pick, { nil: null, freq: 2 })).map(([n, p]) => new CreateTag(n, p));
const createNote = fc.option(pick, { nil: null, freq: 2 }).map((t) => new CreateNote(t));
const mergeTags = fc.tuple(pick, pick).map(([s, t]) => new MergeTags(s, t));
const moveTag = fc.tuple(pick, fc.option(pick, { nil: null, freq: 3 })).map(([t, p]) => new MoveTag(t, p));
/** Creating comes up more often than the rest: most commands need tags and notes to act on. */
const commandArbs = [
  createTag, createTag, createNote, createNote,
  fc.array(name, { minLength: 1, maxLength: 3 }).map((s) => new CreateFromNoteBody(s)),
  fc.tuple(pick, name, fc.boolean()).map(([t, n, v]) => new RenameTag(t, n, v)),
  moveTag, moveTag, moveTag,
  pick.map((t) => new DeleteTag(t)),
  pick.map((t) => new RestoreTag(t)),
  mergeTags, mergeTags, mergeTags,
  fc.tuple(pick, pick).map(([t, f]) => new AddFunction(t, f)),
  pick.map((t) => new RemoveFunction(t)),
  pick.map((t) => new RemoveFunction(t)),
  fc.tuple(pick, pick).map(([n, t]) => new TagNote(n, t)),
  fc.tuple(pick, pick).map(([n, t]) => new TagNote(n, t)),
  pick.map((n) => new UntagNote(n)),
  pick.map((n) => new DeleteNote(n)),
  pick.map((n) => new RestoreNote(n)),
  pick.map((n) => new DuplicateNote(n)),
  fc.tuple(pick, fc.constantFrom("MIT", "ACM", "NTU")).map(([n, v]) => new SetField(n, v)),
  fc.constant(new UndoRename()),
  fc.constant(new UndoRename()),
  fc.tuple(pick, name, fc.boolean()).map(([t, n, v]) => new RenameTag(t, n, v)),
  fc.constant(new SettleOnNothing()),
];

// ── Invariants, after every command ─────────────────────────────────────────

const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

async function verify(m: Model, real: Real, after: string): Promise<void> {
  const where = `after ${after}`;
  // replaying the structure log's tag applications and removals gives the tags the notes carry now (causal-stamps S2)
  expect(await workspaceTagProblems(real.ws), `${where}: structure_log replay`).toEqual([]);
  const rows = await realTags(real.ws);
  const live = rows.filter((r) => !r.deleted);
  const byId = new Map(live.map((r) => [r.id, r]));

  // The tree: no cycle, no module tag in it, sibling names unique.
  for (const row of live) {
    const seen = new Set<string>();
    for (let cursor: RealTag | undefined = row; cursor; cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined) {
      expect(seen.has(cursor.id), `${where}: parent cycle through ${row.title}`).toBe(false);
      seen.add(cursor.id);
    }
    if (row.module) expect(row.parent_id, `${where}: module tag ${row.module} has a parent`).toBeNull();
    if (row.parent_id) expect(byId.get(row.parent_id)?.module ?? null, `${where}: ${row.title} sits under a module tag`).toBeNull();
    if (row.parent_id) expect(byId.has(row.parent_id), `${where}: ${row.title} has a deleted or missing parent`).toBe(true);
  }
  const siblingKeys = live.filter((r) => !r.module).map((r) => `${r.parent_id}\u0000${r.title}`);
  expect(new Set(siblingKeys).size, `${where}: sibling names are not unique`).toBe(siblingKeys.length);

  // The model's tags, names, parents, liveness and functions.
  for (const t of m.tags.values()) {
    const row = rows.find((r) => r.id === t.id);
    expect(row, `${where}: tag ${t.name} exists`).toBeDefined();
    expect(row!.deleted, `${where}: liveness of ${t.name}`).toBe(t.deleted);
    if (t.module) continue;
    expect(row!.title, `${where}: name of ${t.name}`).toBe(t.name);
    expect(row!.parent_id, `${where}: parent of ${m.pathOf(t.id)}`).toBe(t.parent);
    expect(sorted(row!.extends), `${where}: functions of ${m.pathOf(t.id)}`).toEqual(sorted(t.extends));
  }
  expect(live.filter((r) => !r.module).length, `${where}: live user tags`).toBe(m.userTags().length);

  // The tree and the catalog the client receives.
  const tree = await real.call("GET", "/api/tags/tree");
  ok(tree, "GET /api/tags/tree");
  const treeParents = new Map<string, string | null>((tree.body.tags as Array<{ id: string; parent_id: string | null }>).map((t) => [t.id, t.parent_id]));
  expect(sorted(treeParents.keys()), `${where}: tree lists the live tags`).toEqual(sorted(live.map((r) => r.id)));
  const catalogRes = await real.call("GET", "/api/tags");
  ok(catalogRes, "GET /api/tags");
  const catalog = catalogRes.body as unknown as Array<{ id: string; parent_id: string | null; usage_count: number; schema_extends: string[]; schema_module: string | null; schema_behaviour: unknown; view_module: boolean; effective_modules: string[]; functions: Array<{ id: string; source_tag_id: string; ref_id: string | null }> }>;
  expect(sorted(catalog.map((t) => t.id)), `${where}: catalog lists the live tags`).toEqual(sorted(live.map((r) => r.id)));
  for (const t of catalog) {
    const direct = m.liveNotes().filter((n) => n.tags.has(t.id)).length;
    expect(t.usage_count, `${where}: catalog usage_count of ${m.tags.get(t.id)?.name || m.tags.get(t.id)?.module}`).toBe(direct);
    expect(sorted(t.effective_modules), `${where}: catalog functions of ${m.pathOf(t.id) || m.tags.get(t.id)?.module}`).toEqual(sorted(m.abilities(t.id)));
  }

  // Membership: the model, the backend and the frontend agree.
  const nodeRows = (await q<{ id: string; tag_ids: string[] }>(
    `SELECT n.id::text, COALESCE(ARRAY(SELECT nt.tag_id::text FROM node_tags nt WHERE nt.node_id = n.id), '{}') AS tag_ids
       FROM content_nodes n WHERE n.workspace_id = $1 AND n.node_type = 'content' AND n.deleted_at IS NULL`, [real.ws])).rows;
  const frontNodes: FrontNode[] = nodeRows.map((n) => ({ id: n.id, node_type: "content", class_tag_ids: n.tag_ids, label_tag_ids: [], hidden: false, deleted_at: null, source_type: "manual" }));
  const frontTags: FrontTag[] = catalog.map((t) => ({ id: t.id, parent_id: t.parent_id, schema_extends: t.schema_extends, view_module: t.view_module, schema_module: t.schema_module, schema_behaviour: t.schema_behaviour, effective_modules: t.effective_modules, functions: t.functions }));
  const counts = front.nodeTags.tagMemberCounts(frontTags, frontNodes);
  const usage = front.nodeTags.directTagUsage(frontNodes);
  for (const t of live) {
    const label = m.pathOf(t.id) || t.module || t.title;
    const modelMembers = m.membersOf(t.id);
    const tagIds = await memberTagIds(real.ws, t.id);
    expect(sorted(tagIds), `${where}: memberTagIds(${label})`).toEqual(sorted(m.memberTags(t.id)));
    const backendMembers = nodeRows.filter((n) => n.tag_ids.some((id) => tagIds.includes(id))).map((n) => n.id).sort();
    expect(backendMembers, `${where}: backend members of ${label}`).toEqual(modelMembers);
    expect(sorted(front.nodeTags.memberTagIds(frontTags, t.id)), `${where}: frontend memberTagIds(${label})`).toEqual(sorted(tagIds));
    expect(sorted(front.nodeTags.tagMembers(frontTags, frontNodes, t.id).map((n) => n.id)), `${where}: frontend members of ${label}`).toEqual(modelMembers);
    expect(counts.get(t.id) ?? 0, `${where}: frontend member count of ${label}`).toBe(modelMembers.length);
    expect(usage.get(t.id) ?? 0, `${where}: frontend direct usage of ${label}`).toBe(m.liveNotes().filter((n) => n.tags.has(t.id)).length);
    expect(sorted(await descendantsOf(real.ws, t.id)), `${where}: descendants of ${label}`).toEqual(sorted(m.descendants(t.id)));
    // Functions: the nearest source the frontend finds is there exactly when the backend lists the function.
    for (const module of MODULES) {
      const source = front.tagModules.abilitySource(frontTags, t.id, module);
      expect(!!source, `${where}: frontend sees function ${module} on ${label}`).toBe(m.abilities(t.id).has(module));
    }
  }
  for (const tagName of new Set(m.userTags().map((t) => t.name))) {
    const res = await real.call("POST", "/api/query", { tags: [tagName], limit: 200 });
    ok(res, `query #${tagName}`);
    // A block's row (a `{…}` written in a body) lists the block, not its note as a member.
    const ids = (res.body.rows as Array<{ id: string; block?: unknown }>).filter((r) => !r.block).map((r) => r.id);
    expect(sorted(ids), `${where}: /api/query for #${tagName}`).toEqual(m.membersNamed(tagName));
  }

  // Notes: liveness, direct tags (a deleted tag keeps its junction rows), field values.
  const notes = await realNoteState(real.ws);
  for (const n of m.notes.values()) {
    const row = notes.find((r) => r.id === n.id);
    expect(row, `${where}: note ${n.id.slice(0, 4)} exists`).toBeDefined();
    expect(row!.deleted, `${where}: note ${n.id.slice(0, 4)} liveness`).toBe(n.deleted);
    expect(sorted(row!.tags), `${where}: note ${n.id.slice(0, 4)} direct tags`).toEqual(sorted(n.tags));
    expect(row!.venue, `${where}: field value of note ${n.id.slice(0, 4)}`).toBe(n.venue);
  }

  // A merge's promise: every member of the source carries the target (also after a restore).
  for (const p of m.promises) {
    const note = m.notes.get(p.noteId)!;
    const target = m.tags.get(p.tagId)!;
    if (note.deleted || target.deleted) continue;
    expect(note.tags.has(p.tagId), `${where}: note ${p.noteId.slice(0, 4)} must carry the merge target ${target.name}`).toBe(true);
  }
}

// ── The property and the pinned failures ────────────────────────────────────

beforeAll(async () => {
  if (!isTestDb) return;
  registerShippedModules();
  front = {
    nodeTags: await import(/* @vite-ignore */ frontendLib("nodeTags.ts")) as FrontNodeTags,
    tagModules: await import(/* @vite-ignore */ frontendLib("tagModules.ts")) as FrontTagModules,
  };
});

/** Run a fixed command sequence in a fresh world, verifying after each. */
async function replay(commands: Cmd[]): Promise<void> {
  const real = await newWorld();
  const model = new Model(real, true);
  await verify(model, real, "setup");
  for (const command of commands) {
    expect(command.check(model), `precondition of ${command}`).toBe(true);
    await command.run(model, real);
    await verify(model, real, command.toString());
  }
}

describe.skipIf(!isTestDb)("tags and functions: model-based random test", () => {
  it(`random command sequences keep every invariant (known review items ${INCLUDE_KNOWN ? "included" : "left out"})`, async () => {
    const runs = process.env.PROPS_RUNS ? PROPS_RUNS : DEFAULT_RUNS;
    writeSync(2, `[tags.property] PROPS_SEED=${PROPS_SEED} PROPS_RUNS=${runs} (replay with both set)\n`);
    await checkAsync(fc.asyncProperty(
      fc.commands(commandArbs, { maxCommands: MAX_COMMANDS, size: "large" }),
      async (commands) => {
        const real = await newWorld();
        const model = new Model(real, INCLUDE_KNOWN);
        await verify(model, real, "setup");
        let step = 0;
        const verifying = [...commands].map((command) => ({
          check: (m: Model) => command.check(m),
          run: async (m: Model, r: Real) => { await command.run(m, r); await verify(m, r, `#${++step} ${command}`); },
          toString: () => command.toString(),
        }));
        await fc.asyncModelRun(() => ({ model, real }), verifying);
      },
    ), process.env.PROPS_RUNS ? Infinity : DEFAULT_RUNS);
    writeSync(2, `[tags.property] reach: ${[...reach].sort().map(([k, n]) => `${k}=${n}`).join(", ")}\n`);
  }, 600_000);

  // Review items #4 and #5 are fixed by PR fix/a2-structure-import-backup. `it.fails` goes
  // red when the fix lands: then delete the `.fails` and the PROPS_TAGS_KNOWN switch.
  it(`#4 (${FIX_PR}): a merge also gives the target to a member in the trash, so it has it when restored`, async () => {
    // tag a note with #a, delete the note, merge #a into #b, restore the note
    await replay([
      new CreateTag("a", null), new CreateTag("b", null), new CreateNote(null),
      new TagNote(0, 0), new DeleteNote(0), new MergeTags(0, 1), new RestoreNote(0),
    ]);
  }, 120_000);

  it(`#5 (${FIX_PR}): a note carrying a deleted tag can still be duplicated`, async () => {
    // tag a note with #a, delete #a, duplicate the note
    await replay([
      new CreateTag("a", null), new CreateNote(null), new TagNote(0, 0),
      new DeleteTag(0), new DuplicateNote(0),
    ]);
  }, 120_000);

  // #20 says undoing a rename whose old name was taken is a 500. Through the routes it
  // is not: a rename is TAG_UPDATED, whose undo checks the name (eventRestore/tags.ts).
  // The unchecked path (eventRestore/restore.ts, NODE_UPDATED with a title) only
  // serves events written before renames became TAG_UPDATED, so it is not reachable here.
  it("#20: undoing a rename whose old name was taken is a clean refusal (not reproducible through the routes)", async () => {
    // rename #a to #b, create a new #a, undo the rename: the engine's own check in replay holds the refusal to a 409
    await replay([
      new CreateTag("a", null), new RenameTag(0, "b", true), new CreateTag("a", null), new UndoRename(),
    ]);
  }, 120_000);
});
