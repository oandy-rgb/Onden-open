// Model-based random test of the note-tree operations, driven through the real
// HTTP routes (routes/nodes, routes/events, routes/spaces) against the test
// database. A small in-memory model of the tree says what every command should
// do; after each command the database must match it.
//
// Commands: create (top level, under a note, under a tag), move / reparent
// (into its own subtree, onto a tag, across spaces), reorder, delete (subtree
// soft delete), undo the last delete, restore from History, duplicate,
// change space. Every command is issued by the owner or by a member who may edit space A only.
//
// Invariants, checked after every command (verify) and in the command itself:
//   - no parent_id cycle; no live note under a missing or deleted parent; no
//     note under a tag; a live note is in its live parent's space;
//   - every note the model knows is in the database with the model's parent,
//     title, body, space, sort order and deleted state, and the run left no
//     note the model does not know (restore brings back exactly the notes
//     deleted together with it, because deleted state is compared per note);
//   - a refused command (cycle, tag parent, other space, no permission, deleted
//     target) answers 4xx with a known code and leaves the rows and the events
//     about the run's notes exactly as they were.
//
// PROPS_RUNS (default 20 here: each run is dozens of HTTP calls) and PROPS_SEED
// come from helpers/propsConfig.ts; a failure prints the seed, the shrunk
// command sequence and the replay line.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { getWorkspaceId, pool, q } from "../../db.js";
import nodeRouter from "../../routes/nodes.js";
import eventRouter from "../../routes/events.js";
import spaceRouter from "../../routes/spaces.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { seedClassTag } from "../helpers/seedClassTag.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { seedQ } from "../helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
/** Runs when PROPS_RUNS is not set. */
const DEFAULT_RUNS = 20;
const MAX_COMMANDS = 14;
/** services/noteDuplicate.ts COPY_SUFFIX. */
const COPY_SUFFIX = " (Copy)";

// ── Model ────────────────────────────────────────────────────────────────────

type Who = "owner" | "member";
type SpaceKey = "A" | "B";

type MNode = {
  id: string; title: string; body: string; parent: string | null; space: SpaceKey; sort: number;
  /** Creation order: the tie-break of equal sort orders. */
  seq: number;
  deleted: boolean;
  /** The delete this note went with, until it comes back. */
  group: number | null;
  /** The note that was deleted directly (its delete started the group). */
  groupRoot: boolean;
};

type Model = {
  prefix: string;
  nodes: Map<string, MNode>;
  counter: number;
  groups: number;
  lastDeleted: string | null;
};

type Fixture = {
  ws: string;
  spaces: Record<SpaceKey, string>;
  actors: Record<Who, ActorCtx>;
  tagId: string;
};

// ── HTTP ─────────────────────────────────────────────────────────────────────

let fx!: Fixture;
let serial = 0;
const stamp = Date.now().toString(36);

const app = () => {
  const a = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  a.onError(apiOnError);
  a.use("*", async (c, next) => { c.set("actor", fx.actors[c.req.header("x-test-actor") as Who]); await next(); });
  a.route("/api/nodes", nodeRouter);
  a.route("/api/events", eventRouter);
  a.route("/api/spaces", spaceRouter);
  return a;
};
const server = app();

type Res = { status: number; json: any };
async function call(who: Who, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await server.request(path, {
    method,
    headers: { "x-test-actor": who, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

// Every 4xx the tree commands may answer with, by code (the `error` field).
// Anything else, and any 5xx, fails the run.
const KNOWN_REFUSALS = new Set([
  "parent_not_found", "parent_cycle", "parent_in_other_space", "parent_kind_mismatch",
  "node not found", "not found", "forbidden", "not_found", "node is not deleted",
  "not_movable", "same_space", "parent not found", "source note not found", "cannot move a node under its own descendant",
]);
/** The authority errors name the operation in their message (spine/authority.ts). */
const AUTHORITY_REFUSAL = /^(space role denied '\w+' on this (note|space)|cannot write into space [0-9a-f-]+|space access is below required '\w+')$/;

function refusalProblem(label: string, res: Res): string | null {
  if (res.status < 400 || res.status >= 500) return `${label}: expected a 4xx refusal, got ${res.status} ${JSON.stringify(res.json)}`;
  const code = typeof res.json?.error === "string" ? res.json.error : "";
  return KNOWN_REFUSALS.has(code) || AUTHORITY_REFUSAL.test(code) ? null : `${label}: refused ${res.status} with an unknown code ${JSON.stringify(res.json)}`;
}

// ── Reading the database ─────────────────────────────────────────────────────

type Row = {
  id: string; parent_id: string | null; title: string; markdown: string; space_id: string | null;
  sort_order: number; deleted: boolean; updated_at: string; node_type: string;
};

const rowsOfRun = async (m: Model): Promise<Row[]> => (await q<Row>(
  `SELECT id::text, parent_id::text, title, markdown, space_id::text, sort_order, node_type,
          deleted_at IS NOT NULL AS deleted, updated_at::text
     FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2 ORDER BY id`,
  [fx.ws, `${m.prefix}%`])).rows;

const eventCount = async (m: Model): Promise<number> => Number((await q<{ n: string }>(
  `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND target_id = ANY($2::text[])`,
  [fx.ws, [...m.nodes.keys()]])).rows[0]!.n);

const snapshot = async (m: Model) => ({ rows: await rowsOfRun(m), events: await eventCount(m) });

/** Run a request that the model says must be refused: 4xx with a known code,
 *  and nothing in the database moves. */
async function expectRefused(m: Model, label: string, send: () => Promise<Res>): Promise<void> {
  const before = await snapshot(m);
  const res = await send();
  expect(refusalProblem(label, res), label).toBeNull();
  expect(await snapshot(m), `${label}: a refused request changed the database`).toEqual(before);
}

async function expectOk(label: string, send: () => Promise<Res>, status: number | number[] = [200, 201]): Promise<any> {
  const res = await send();
  const want = Array.isArray(status) ? status : [status];
  expect(want, `${label}: ${res.status} ${JSON.stringify(res.json)}`).toContain(res.status);
  return res.json;
}

// ── Model helpers ────────────────────────────────────────────────────────────

const allNodes = (m: Model): MNode[] => [...m.nodes.values()].sort((a, b) => a.seq - b.seq);
const liveNodes = (m: Model) => allNodes(m).filter((n) => !n.deleted);
const pick = <T>(list: T[], i: number): T => list[i % list.length]!;
const can = (who: Who, space: SpaceKey) => who === "owner" || space === "A";
const childrenOf = (m: Model, id: string) => allNodes(m).filter((n) => n.parent === id);

/** Descendants of `id` through any parent link, deleted or not. */
function subtree(m: Model, id: string): MNode[] {
  const out: MNode[] = [];
  const queue = [id];
  while (queue.length) for (const c of childrenOf(m, queue.shift()!)) { out.push(c); queue.push(c.id); }
  return out;
}
/** Descendants reached through live notes only: what a delete takes along. */
function liveSubtree(m: Model, id: string): MNode[] {
  const out: MNode[] = [];
  const queue = [id];
  while (queue.length) for (const c of childrenOf(m, queue.shift()!).filter((n) => !n.deleted)) { out.push(c); queue.push(c.id); }
  return out;
}
/** Deleted notes above `n`, top first. */
function deletedAncestors(m: Model, n: MNode): MNode[] {
  const out: MNode[] = [];
  for (let p = n.parent ? m.nodes.get(n.parent) : undefined; p; p = p.parent ? m.nodes.get(p.parent) : undefined) {
    if (p.deleted) out.unshift(p);
  }
  return out;
}

function applyDelete(m: Model, n: MNode): void {
  const group = ++m.groups;
  for (const d of [n, ...liveSubtree(m, n.id)]) { d.deleted = true; d.group = group; d.groupRoot = d === n; }
  m.lastDeleted = n.id;
}

/** restoreLive (services/nodeTrash.ts): the deleted notes above it, the note,
 *  and, when it was deleted directly, the notes deleted with it. */
function applyRestore(m: Model, n: MNode): void {
  const revive = (d: MNode) => { d.deleted = false; d.group = null; d.groupRoot = false; };
  for (const a of deletedAncestors(m, n)) revive(a);
  const together = n.groupRoot ? allNodes(m).filter((d) => d.deleted && d.group === n.group && d !== n) : [];
  revive(n);
  together.forEach(revive);
}

type BodySpec = { sections: number; lines: number };
function makeBody(m: Model, spec: BodySpec): string {
  const line = () => { const n = m.counter++; return n % 4 === 0 ? `- [ ] task ${n}` : `text ${n}`; };
  const out: string[] = [];
  for (let i = 0; i < (spec.sections === 0 ? spec.lines : Math.min(spec.lines, 1)); i++) out.push(line());
  for (let s = 0; s < spec.sections; s++) {
    out.push(`## ${m.prefix}H${m.counter++}`);
    for (let i = 0; i < (s % 3); i++) out.push(line());
  }
  return out.join("\n");
}
const nextTitle = (m: Model) => `${m.prefix}N${m.counter++}`;

function addNode(m: Model, n: Omit<MNode, "seq" | "deleted" | "group" | "groupRoot">): MNode {
  const node: MNode = { ...n, seq: m.counter++, deleted: false, group: null, groupRoot: false };
  m.nodes.set(node.id, node);
  return node;
}

// ── Invariants over the whole run ────────────────────────────────────────────

async function verify(m: Model, after: string): Promise<void> {
  const rows = await rowsOfRun(m);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const problems: string[] = [];
  const spaceId = (k: SpaceKey) => fx.spaces[k];
  const name = (id: string | null) => (id ? m.nodes.get(id)?.title.slice(m.prefix.length) ?? id.slice(0, 8) : "root");

  for (const r of rows) if (!m.nodes.has(r.id)) problems.push(`unexpected note "${r.title}" (parent ${name(r.parent_id)}, ${r.deleted ? "deleted" : "live"})`);
  for (const n of m.nodes.values()) {
    const r = byId.get(n.id);
    const label = n.title.slice(m.prefix.length);
    if (!r) { problems.push(`${label} is missing from the database`); continue; }
    if (r.deleted !== n.deleted) problems.push(`${label} is ${r.deleted ? "deleted" : "live"}, model says ${n.deleted ? "deleted" : "live"}`);
    if (r.parent_id !== n.parent) problems.push(`${label} has parent ${name(r.parent_id)}, model says ${name(n.parent)}`);
    if (r.title !== n.title) problems.push(`${label} has title "${r.title}", model says "${n.title}"`);
    if (r.markdown !== n.body) problems.push(`${label} has body ${JSON.stringify(r.markdown)}, model says ${JSON.stringify(n.body)}`);
    if (r.space_id !== spaceId(n.space)) problems.push(`${label} is in another space than the model's ${n.space}`);
    if (r.sort_order !== n.sort) problems.push(`${label} has sort order ${r.sort_order}, model says ${n.sort}`);
  }
  for (const r of rows) {
    if (r.parent_id === fx.tagId) problems.push(`${r.title.slice(m.prefix.length)} is parented to a tag`);
    const label = r.title.slice(m.prefix.length);
    const seen = new Set<string>([r.id]);
    for (let p = r.parent_id; p; p = byId.get(p)?.parent_id ?? null) {
      if (seen.has(p)) { problems.push(`${label} is in a parent cycle`); break; }
      seen.add(p);
    }
    if (!r.deleted && r.parent_id) {
      const parent = byId.get(r.parent_id);
      if (!parent) problems.push(`live ${label} has a missing parent`);
      else if (parent.deleted) problems.push(`live ${label} has a deleted parent ${name(parent.id)}`);
      else if (parent.space_id !== r.space_id) problems.push(`live ${label} is in another space than its parent`);
    }
  }
  problems.push(...await structureLogProblems(m, rows));
  expect(problems, `after ${after}`).toEqual([]);
}

/** structure_log is the history of every note's parent, space and deleted state: folding it from the start
 *  (each row's new value, in log order) must give what the table holds now (S1 of causal-stamps-2026-11-12). */
async function structureLogProblems(m: Model, rows: Row[]): Promise<string[]> {
  const log = (await q<{ row_key: string; field: string; new_value: string | null }>(
    `SELECT row_key, field, new_value FROM structure_log
      WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = ANY($2::text[]) ORDER BY id`,
    [fx.ws, [...m.nodes.keys()]])).rows;
  const folded = new Map<string, { parent: string | null; space: string | null; deleted: string | null }>();
  for (const { row_key, field, new_value } of log) {
    const state = folded.get(row_key) ?? { parent: null, space: null, deleted: null };
    state[field as "parent" | "space" | "deleted"] = new_value;
    folded.set(row_key, state);
  }
  const problems: string[] = [];
  for (const r of rows) {
    const f = folded.get(r.id);
    const label = r.title.slice(m.prefix.length);
    if (!f) { problems.push(`${label} has no structure_log rows`); continue; }
    if (f.parent !== r.parent_id) problems.push(`${label}: replaying structure_log gives parent ${f.parent}, the table has ${r.parent_id}`);
    if (f.space !== r.space_id) problems.push(`${label}: replaying structure_log gives space ${f.space}, the table has ${r.space_id}`);
    if (f.deleted !== String(r.deleted)) problems.push(`${label}: replaying structure_log gives deleted ${f.deleted}, the table has ${r.deleted}`);
  }
  return problems;
}

// ── Commands ─────────────────────────────────────────────────────────────────

type Real = Record<string, never>;
abstract class Cmd implements fc.AsyncCommand<Model, Real, false> {
  check(_m: Readonly<Model>): boolean { return true; }
  async run(m: Model): Promise<void> {
    await this.exec(m);
    await verify(m, this.toString());
  }
  abstract exec(m: Model): Promise<void>;
  abstract toString(): string;
}
const who = fc.constantFrom<Who>("owner", "owner", "member");
const idx = fc.nat(40);
const bodySpec = fc.record({ sections: fc.constantFrom(0, 0, 2, 3), lines: fc.nat(3) });

type ParentRef = { k: "root"; space: SpaceKey } | { k: "note"; i: number } | { k: "tag" };
const parentRef: fc.Arbitrary<ParentRef> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom<SpaceKey>("A", "B").map((space) => ({ k: "root" as const, space })) },
  { weight: 5, arbitrary: idx.map((i) => ({ k: "note" as const, i })) },
  { weight: 1, arbitrary: fc.constant({ k: "tag" as const }) },
);
const describeRef = (r: ParentRef) => r.k === "root" ? `top level of space ${r.space}` : r.k === "tag" ? "a tag" : `note #${r.i}`;

class Create extends Cmd {
  constructor(readonly who: Who, readonly parent: ParentRef, readonly body: BodySpec, readonly sort: number) { super(); }
  async exec(m: Model) {
    const id = randomUUID();
    const title = nextTitle(m);
    const body = makeBody(m, this.body);
    const parent = this.parent.k === "note" ? pick(allNodes(m), this.parent.i) : null;
    const send = () => call(this.who, "POST", "/api/nodes", {
      id, title, markdown: body, sort_order: this.sort,
      ...(this.parent.k === "root" ? { parent_id: null, space_id: fx.spaces[this.parent.space] } : {}),
      ...(this.parent.k === "tag" ? { parent_id: fx.tagId } : {}),
      ...(parent ? { parent_id: parent.id } : {}),
    });
    const space = this.parent.k === "root" ? this.parent.space : parent?.space;
    if (!space || parent?.deleted || !can(this.who, space)) return expectRefused(m, this.toString(), send);
    await expectOk(this.toString(), send, 201);
    addNode(m, { id, title, body, parent: parent?.id ?? null, space, sort: this.sort });
  }
  toString() { return `${this.who} creates a note (${this.body.sections} sections, ${this.body.lines} lines) at ${describeRef(this.parent)}`; }
}

type MoveTarget = { k: "root" } | { k: "note"; i: number } | { k: "tag" } | { k: "self" } | { k: "descendant"; i: number };
const moveTarget: fc.Arbitrary<MoveTarget> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ k: "root" as const }) },
  { weight: 5, arbitrary: idx.map((i) => ({ k: "note" as const, i })) },
  { weight: 1, arbitrary: fc.constant({ k: "tag" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "self" as const }) },
  { weight: 2, arbitrary: idx.map((i) => ({ k: "descendant" as const, i })) },
);

class Move extends Cmd {
  constructor(readonly who: Who, readonly node: number, readonly target: MoveTarget) { super(); }
  async exec(m: Model) {
    const n = pick(allNodes(m), this.node);
    const below = subtree(m, n.id);
    const t = this.target;
    const target = t.k === "note" ? pick(allNodes(m), t.i)
      : t.k === "self" ? n
      : t.k === "descendant" && below.length ? pick(below, t.i)
      : null;
    const parentId = t.k === "tag" ? fx.tagId : target?.id ?? null;
    const send = () => call(this.who, "PATCH", `/api/nodes/${n.id}`, { parent_id: parentId });
    // A note named as its own parent goes to the top level, as on create
    // (services/nodeUpdate.ts, noteCreate.ts): not a cycle, not refused.
    const toTop = t.k === "root" || t.k === "self" || target === n || (t.k === "descendant" && !below.length);
    const ok = !n.deleted && can(this.who, n.space)
      && (toTop || (target !== null && !target.deleted && !below.includes(target) && target.space === n.space));
    if (!ok) return expectRefused(m, this.toString(), send);
    await expectOk(this.toString(), send);
    n.parent = toTop ? null : target!.id;
  }
  toString() {
    const t = this.target;
    return `${this.who} moves note #${this.node} to ${t.k === "root" ? "the top level" : t.k === "tag" ? "a tag" : t.k === "self" ? "itself (top level)" : t.k === "descendant" ? `its own descendant #${t.i}` : `note #${t.i}`}`;
  }
}

class Reorder extends Cmd {
  constructor(readonly who: Who, readonly node: number, readonly sort: number) { super(); }
  async exec(m: Model) {
    const n = pick(allNodes(m), this.node);
    const send = () => call(this.who, "PATCH", `/api/nodes/${n.id}`, { sort_order: this.sort });
    if (n.deleted || !can(this.who, n.space)) return expectRefused(m, this.toString(), send);
    await expectOk(this.toString(), send);
    n.sort = this.sort;
  }
  toString() { return `${this.who} sets the sort order of note #${this.node} to ${this.sort}`; }
}

class Delete extends Cmd {
  constructor(readonly who: Who, readonly node: number) { super(); }
  async exec(m: Model) {
    const n = pick(allNodes(m), this.node);
    const send = () => call(this.who, "DELETE", `/api/nodes/${n.id}`);
    if (n.deleted || !can(this.who, n.space)) return expectRefused(m, this.toString(), send);
    await expectOk(this.toString(), send);
    applyDelete(m, n);
  }
  toString() { return `${this.who} deletes note #${this.node} with its subtree`; }
}

/** Undo the last delete, or undelete any note (live ones are refused). */
class Undelete extends Cmd {
  constructor(readonly who: Who, readonly last: boolean, readonly node: number) { super(); }
  check(m: Readonly<Model>) { return m.nodes.size > 0; }
  async exec(m: Model) {
    const n = (this.last && m.lastDeleted ? m.nodes.get(m.lastDeleted) : undefined) ?? pick(allNodes(m).filter((d) => d.deleted).length ? allNodes(m).filter((d) => d.deleted) : allNodes(m), this.node);
    const send = () => call(this.who, "POST", `/api/nodes/${n.id}/undelete`);
    if (!n.deleted || !can(this.who, n.space)) return expectRefused(m, this.toString(), send);
    await expectOk(this.toString(), send);
    applyRestore(m, n);
  }
  toString() { return `${this.who} undoes ${this.last ? "the last delete" : `the delete of note #${this.node}`}`; }
}

/** History's restore of the NODE_DELETED event of a note deleted directly. */
class RestoreFromHistory extends Cmd {
  constructor(readonly who: Who, readonly node: number) { super(); }
  check(m: Readonly<Model>) { return [...m.nodes.values()].some((n) => n.deleted && n.groupRoot); }
  async exec(m: Model) {
    const n = pick(allNodes(m).filter((d) => d.deleted && d.groupRoot), this.node);
    const eventId = (await q<{ id: string }>(
      `SELECT deleted_by_event_id::text AS id FROM content_nodes WHERE id = $1`, [n.id])).rows[0]!.id;
    const send = () => call(this.who, "POST", `/api/events/${eventId}/restore`, { cascade: true });
    if (!can(this.who, n.space)) return expectRefused(m, this.toString(), send);
    await expectOk(this.toString(), send);
    applyRestore(m, n);
  }
  toString() { return `${this.who} restores deleted note #${this.node} from History`; }
}

class Duplicate extends Cmd {
  constructor(readonly who: Who, readonly node: number) { super(); }
  async exec(m: Model) {
    const n = pick(allNodes(m), this.node);
    const send = () => call(this.who, "POST", `/api/nodes/${n.id}/duplicate`, {});
    if (n.deleted || !can(this.who, n.space)) return expectRefused(m, this.toString(), send);
    const copy = await expectOk(this.toString(), send, 201);
    // Where the copy sits among its siblings is not pinned here: take its sort order.
    addNode(m, { id: copy.id, title: n.title + COPY_SUFFIX, body: n.body, parent: n.parent, space: n.space, sort: copy.sort_order });
  }
  toString() { return `${this.who} duplicates note #${this.node}`; }
}

class ChangeSpace extends Cmd {
  constructor(readonly who: Who, readonly node: number, readonly to: SpaceKey) { super(); }
  async exec(m: Model) {
    const n = pick(allNodes(m), this.node);
    const send = async (): Promise<Res> => {
      const preview = await call(this.who, "GET", `/api/spaces/move-preview?node=${n.id}&to=${fx.spaces[this.to]}`);
      if (preview.status >= 300) return preview;
      return call(this.who, "POST", "/api/spaces/move", {
        node_id: n.id, to_space_id: fx.spaces[this.to], membership_epoch: preview.json.membership_epoch,
      });
    };
    // Only the owner manages a shared space; moving into the note's own space is refused.
    if (n.deleted || this.who !== "owner" || n.space === this.to) return expectRefused(m, this.toString(), send);
    await expectOk(this.toString(), send);
    for (const d of [n, ...subtree(m, n.id)]) d.space = this.to;
    n.parent = null;
  }
  toString() { return `${this.who} moves note #${this.node} and its subtree to space ${this.to}`; }
}

const commandArbs = (): fc.Arbitrary<Cmd>[] => [
  fc.tuple(who, parentRef, bodySpec, fc.nat(5)).map(([w, p, b, s]) => new Create(w, p, b, s)),
  fc.tuple(who, parentRef, bodySpec, fc.nat(5)).map(([w, p, b, s]) => new Create(w, p, b, s)),
  fc.tuple(who, idx, moveTarget).map(([w, n, t]) => new Move(w, n, t)),
  fc.tuple(who, idx, moveTarget).map(([w, n, t]) => new Move(w, n, t)),
  fc.tuple(who, idx, fc.nat(9)).map(([w, n, s]) => new Reorder(w, n, s)),
  fc.tuple(who, idx).map(([w, n]) => new Delete(w, n)),
  fc.tuple(who, idx).map(([w, n]) => new Delete(w, n)),
  fc.tuple(who, fc.boolean(), idx).map(([w, l, n]) => new Undelete(w, l, n)),
  fc.tuple(who, idx).map(([w, n]) => new RestoreFromHistory(w, n)),
  fc.tuple(who, idx).map(([w, n]) => new RestoreFromHistory(w, n)),
  fc.tuple(who, idx).map(([w, n]) => new Duplicate(w, n)),
  fc.tuple(who, idx, fc.constantFrom<SpaceKey>("A", "B")).map(([w, n, t]) => new ChangeSpace(w, n, t)),
];

// ── Setup ────────────────────────────────────────────────────────────────────

/** A fresh run: its own title prefix, and a few notes to act on. */
async function freshModel(): Promise<Model> {
  const m: Model = { prefix: `PT${stamp}r${serial++} `, nodes: new Map(), counter: 0, groups: 0, lastDeleted: null };
  const seed = (parent: ParentRef, body: BodySpec) => new Create("owner", parent, body, 0).run(m);
  await seed({ k: "root", space: "A" }, { sections: 2, lines: 1 });
  await seed({ k: "note", i: 0 }, { sections: 0, lines: 2 });
  await seed({ k: "root", space: "B" }, { sections: 0, lines: 1 });
  return m;
}

const sequence = (cmds: Cmd[]) => fc.asyncModelRun(async () => ({ model: await freshModel(), real: {} as Real }), cmds as fc.AsyncCommand<Model, Real, false>[]);

describe.skipIf(!isTestDb)("note tree operations vs a model of the tree", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    const ws = await getWorkspaceId();
    const owner = await persistActor(ws, { id: "", name: "Tree Owner", role: "admin", type: "human" });
    const member = await persistActor(ws, { id: "", name: "Tree Member", role: "editor", type: "human" });
    // The owner is in both spaces and manages them; the member edits space A only.
    const A = await makeSpace(ws, `tree A ${stamp}`, [{ id: owner.id, permission: "edit" }, { id: member.id, permission: "edit" }]);
    const B = await makeSpace(ws, `tree B ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const { tagId } = await seedClassTag(ws, { name: `tree tag ${stamp}`, title: `tree tag ${stamp}`, slug: `tree-tag-${stamp}` });
    fx = { ws, spaces: { A, B }, actors: { owner, member }, tagId };
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [fx.ws, `PT${stamp}r%`]);
    await pool.end();
  });

  it("random command sequences keep the tree consistent with the model", async () => {
    await checkAsync(
      fc.asyncProperty(fc.commands(commandArbs(), { maxCommands: MAX_COMMANDS }), (cmds) => sequence(cmds as unknown as Cmd[])),
      process.env.PROPS_RUNS ? Infinity : DEFAULT_RUNS,
    );
  }, 600_000);
});
