// Random edit sequences against several notes that link to each other, through
// the real save route (PATCH /api/nodes/:id on the assembled app), compared
// after every step with what you get by parsing the current bodies from
// scratch.
//
// What is indexed, and what the test recomputes:
//   node_edges (origin 'wikilink')  the note-to-note links, services/wikilinkEdges
//                                   (a save re-derives the edges OUT of the note,
//                                   a rename / trash / undelete the edges INTO it).
//                                   Recomputed from every live body with the
//                                   shared parser (utils.extractWikilinks, which
//                                   reads `[[x]]` in any form: `[[x#^id]]`,
//                                   `[[x|alias]]`, `![[x]]` embeds, code) and the
//                                   naming rule (same space, title ignoring case,
//                                   or slug).
//   block_nodes                     tagged paragraphs, services/blockNodes. A block's
//                                   identity is its anchor (block_anchors), never text:
//                                   the save gives a tagged paragraph an anchor and a row
//                                   known by that id. Recomputed with @onden/markdown
//                                   parseBlocks on the body the save stored and the
//                                   note's valid anchors.
//   [[note#^id]] block links        have no table: they resolve against the target's
//                                   valid anchors when read. The test checks that a link
//                                   made from a paragraph's id (its anchor's) still
//                                   resolves while that paragraph is in the note.
//
// Edits (whole-body saves, like the editor's, which never carry an id): drop /
// add / paste (a copy of the text) paragraphs, links in every form, a rename (also to a name some body already links), a move to
// the other space, trash and undelete, a save of the same text. Names are reused across steps, so
// links to renamed, trashed and never-existing notes all occur.
//
// Invariants (names in the failure message):
//   edges        live-to-live edges equal the from-scratch edges (a link to a
//                trashed note keeps its edge by design and is not compared)
//   block-index  the note's live block_nodes equal parseBlocks of its stored body
//                and valid anchors
//   keep         a tagged paragraph kept by an edit keeps its anchor id (a pasted
//                copy of it may take the id instead, one of the two keeps it)
//   resolves     a `[[note#^id]]` made from a paragraph's anchor id resolves while
//                the paragraph is in the note
//   dup-block    no block id is used by two block nodes of a note
//   no-stray-id  an untagged paragraph never gets a block node (nor does text
//                that merely contains `^id` become one)
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/blockLinkIndex
//          (the failure prints the seed and the shrunk edits).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createHash, randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import { extractWikilinks } from "../../utils.js";
import { parseBlocks, slugify, CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL } from "@onden/markdown";
import { checkAsync } from "../helpers/propsConfig.js";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

let sessionExternalId: string | null = null;
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId
          ? { user: { id: sessionExternalId, name: sessionExternalId, email: `${sessionExternalId}@props.test` } }
          : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const { app } = isTestDb ? await import("../../app.js") : { app: null as never };

async function call(method: string, path: string, json?: unknown): Promise<{ status: number; body: any; text: string }> {
  sessionExternalId = "props-owner";
  try {
    const res = await app.request(path, {
      method,
      // A page says which block-identity protocol it speaks (clientGate.ts); without it a person's note write is refused.
      headers: { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body, text };
  } finally {
    sessionExternalId = null;
  }
}

// ── model ───────────────────────────────────────────────────────────────────

type Para = { tok: string; tagged: boolean; id: string | null };
type MadeLink = { tok: string; id: string; targetNote: number; title: string };
type NoteM = {
  idx: number; id: string; space: "A" | "B"; title: string;
  paras: Para[]; made: MadeLink[]; trashed: boolean; body: string;
};
type World = { notes: NoteM[]; stamp: string; counter: number };

const N_NOTES = 5; // 0-3 in space A, 4 in space B
const FORMS = ["exact", "lower", "slug", "alias"] as const;

type LinkSpec = { target: number; form: number; embed: boolean; ref: number | null; inCode: boolean };
type Op =
  | { op: "edit"; note: number; keep: boolean[]; add: Array<{ tagged: boolean; at: number }>; paste: number | null; pasteAt: number; links: LinkSpec[] }
  | { op: "rename"; note: number; toGhost: boolean }
  | { op: "trash" | "undelete" | "resave" | "move"; note: number };

const linkSpec: fc.Arbitrary<LinkSpec> = fc.record({
  target: fc.nat(N_NOTES), // N_NOTES = a title no note has
  form: fc.nat(FORMS.length - 1),
  embed: fc.boolean(),
  ref: fc.option(fc.nat(6), { nil: null }),
  inCode: fc.boolean(),
});
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    op: fc.constant("edit" as const), note: fc.nat(N_NOTES - 1),
    keep: fc.array(fc.boolean(), { maxLength: 6 }),
    add: fc.array(fc.record({ tagged: fc.boolean(), at: fc.nat(8) }), { maxLength: 3 }),
    paste: fc.option(fc.nat(6), { nil: null }), pasteAt: fc.nat(8),
    links: fc.array(linkSpec, { maxLength: 5 }),
  }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("rename" as const), note: fc.nat(N_NOTES - 1), toGhost: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("trash" as const), note: fc.nat(N_NOTES - 1) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("undelete" as const), note: fc.nat(N_NOTES - 1) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("resave" as const), note: fc.nat(N_NOTES - 1) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("move" as const), note: fc.nat(N_NOTES - 1) }) },
);
const opsArb = fc.array(opArb, { minLength: 2, maxLength: 14 });

const ghostTitle = (w: World) => `Ghost ${w.stamp}`;
const titleFor = (w: World, spec: LinkSpec): string => {
  const base = spec.target >= N_NOTES ? ghostTitle(w) : w.notes[spec.target]!.title;
  switch (FORMS[spec.form]) {
    case "lower": return base.toLowerCase();
    case "slug": return slugify(base);
    case "alias": return `${base}|shown`;
    default: return base;
  }
};

/** A paragraph's words: its token and a run of letters of its own. Paragraphs that differ by one character
 *  ("Para p4e text" / "Para p6e text") are the same text to a similarity check, and an anchor follows text by
 *  similarity once a line diff cannot place it (blockAnchors/similarity.ts); the random notes here are not meant to
 *  test that heuristic on near-twins, only that an anchor follows its own paragraph. */
const paraText = (tok: string): string => `Para ${tok} ${createHash("sha1").update(tok).digest("hex").slice(0, 24).replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!)}`;

/** The body an edit saves: its paragraphs (text only: the identity is the
 *  anchor the server made, never written into the text), then one paragraph per link. */
function renderBody(w: World, n: NoteM, links: LinkSpec[]): { body: string; made: MadeLink[] } {
  const made: MadeLink[] = [];
  const paras = n.paras.map((p) => `${paraText(p.tok)}${p.tagged ? " {alpha}" : ""}`);
  const linkLines = links.map((spec) => {
    const t = spec.target < N_NOTES ? w.notes[spec.target]! : null;
    const para = t && spec.ref !== null ? t.paras.filter((p) => p.id)[spec.ref % Math.max(1, t.paras.filter((p) => p.id).length)] : null;
    const id = para?.id ?? (spec.ref !== null ? "deadbeef" : null);
    const title = titleFor(w, spec);
    const [target, alias] = title.split("|");
    const inner = `${target}${id ? `#^${id}` : ""}${alias ? `|${alias}` : ""}`;
    if (para && id && t && FORMS[spec.form] === "exact") made.push({ tok: para.tok, id, targetNote: t.idx, title: t.title });
    const text = `${spec.embed ? "!" : ""}[[${inner}]]`;
    return spec.inCode ? `\`\`\`\n${text}\n\`\`\`` : `See ${text}`;
  });
  return { body: [`Note ${n.idx} ${w.stamp}`, ...paras, ...linkLines].join("\n\n") + "\n", made };
}

/** The visible block row whose label is paragraph `tok`'s, as its ref (the anchor id), or null. */
async function refOfPara(noteId: string, tok: string): Promise<string | null> {
  return (await q<{ block_ref: string }>(
    `SELECT block_ref FROM block_nodes WHERE note_id = $1 AND hidden_at IS NULL AND label = $2 LIMIT 1`, [noteId, paraText(tok)],
  )).rows[0]?.block_ref ?? null;
}
const validAnchors = async (noteId: string) => (await q<{ id: string; from: number; to: number }>(
  `SELECT anchor_id AS id, from_utf16 AS "from", to_utf16 AS "to" FROM block_anchors WHERE note_id = $1 AND status = 'valid'`, [noteId])).rows;
/** The lines of a paragraph, pasted copies (tok + "c") included, in text order. */
const lineOf = (body: string, tok: string): string[] => body.split("\n").filter((l) => new RegExp(`\\bPara ${tok}c?\\b`).test(l));

type Row = { id: string; title: string; slug: string; markdown: string; space_id: string; deleted: boolean };

async function rows(ids: string[]): Promise<Map<string, Row>> {
  const r = await q<Row>(
    `SELECT id::text, title, slug, coalesce(markdown, '') AS markdown, space_id::text, deleted_at IS NOT NULL AS deleted
       FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids],
  );
  return new Map(r.rows.map((x) => [x.id, x]));
}

const settle = () => awaitAllDispatchers();

type Violation = { rule: string; detail: string };

/** After a step: read the database, check every invariant, fold the ids the
 *  server wrote back into the model. */
async function verify(w: World, step: string, before: Map<string, Row>, dupOf: Map<number, string>): Promise<Violation[]> {
  const bad: Violation[] = [];
  const db = await rows(w.notes.map((n) => n.id));
  const where = `after ${step}\n${w.notes.map((n) => `--- note ${n.idx} "${db.get(n.id)!.title}"${db.get(n.id)!.deleted ? " (trashed)" : ""} ---\n${db.get(n.id)!.markdown}`).join("")}`;

  // Paragraph ids: keep, dup-block, no-stray-id, and read back.
  for (const n of w.notes) {
    const row = db.get(n.id)!;
    n.title = row.title;
    if (row.deleted) continue;
    const refs = (await q<{ block_ref: string }>(`SELECT block_ref FROM block_nodes WHERE note_id = $1`, [n.id])).rows.map((r) => r.block_ref);
    const dup = refs.find((r, i) => refs.indexOf(r) !== i);
    if (dup) bad.push({ rule: "dup-block", detail: `note ${n.idx} uses ^${dup} twice\n${where}` });
    const pastedTok = dupOf.get(n.idx);
    for (const p of n.paras) {
      const lines = lineOf(row.markdown, p.tok);
      const own = lines.length ? await refOfPara(n.id, p.tok) : null;
      if (!p.tagged && own) bad.push({ rule: "no-stray-id", detail: `untagged paragraph ${p.tok} got a block node ^${own}\n${where}` });
      // A pasted copy (tok + "c") may be the one that took the id; the source is checked instead.
      if (p.tagged && p.id && lines.length && !p.tok.endsWith("c")) {
        const isPasteSource = pastedTok === p.tok;
        const anyoneHas = (await Promise.all([p.tok, `${p.tok}c`].map((t) => refOfPara(n.id, t)))).includes(p.id);
        // A paste above the paragraph may hand its anchor to the copy (a pure-level
        // finding, blockIds.property.test.ts): here only that someone keeps it.
        if (isPasteSource ? !anyoneHas : own !== p.id) {
          bad.push({ rule: "keep", detail: `paragraph ${p.tok} had ^${p.id}, now ${own ? `^${own}` : "none"}\n${where}` });
        }
      }
      p.id = own ?? (lines.length ? null : p.id);
    }
  }

  // [[note#^id]] links made from a paragraph's id still resolve.
  for (const n of w.notes) {
    if (db.get(n.id)!.deleted) continue;
    for (const link of n.made) {
      const target = w.notes[link.targetNote]!;
      const t = db.get(target.id)!;
      if (t.deleted || t.title !== link.title || !target.paras.some((p) => p.tok === link.tok)) continue;
      if (!(await validAnchors(t.id)).some((a) => a.id === link.id)) {
        bad.push({ rule: "resolves", detail: `note ${n.idx} links [[${link.title}#^${link.id}]] and note ${target.idx} no longer has that id\n${where}` });
      }
    }
  }

  // Edges: live to live equal the from-scratch edges.
  const live = w.notes.filter((n) => !db.get(n.id)!.deleted);
  const expected: string[] = [];
  for (const s of live) {
    const sr = db.get(s.id)!;
    for (const link of extractWikilinks(sr.markdown)) {
      for (const t of live) {
        const tr = db.get(t.id)!;
        if (t.id === s.id || tr.space_id !== sr.space_id) continue;
        if (tr.title.normalize("NFC").toLowerCase() === link.toLowerCase() || tr.slug === slugify(link)) expected.push(`${s.idx}>${t.idx}`);
      }
    }
  }
  const liveIds = new Set(live.map((n) => n.id));
  const byId = new Map(w.notes.map((n) => [n.id, n.idx]));
  const actual = (await q<{ s: string; t: string }>(
    `SELECT source_node_id::text AS s, target_node_id::text AS t FROM node_edges
      WHERE origin = 'wikilink' AND status = 'active' AND source_node_id = ANY($1::uuid[]) AND target_node_id = ANY($1::uuid[])`,
    [w.notes.map((n) => n.id)],
  )).rows.filter((e) => liveIds.has(e.s) && liveIds.has(e.t)).map((e) => `${byId.get(e.s)}>${byId.get(e.t)}`);
  const want = [...new Set(expected)].sort();
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(want)) {
    bad.push({ rule: "edges", detail: `edges (source>target)\n  index:        ${[...actual].sort().join(" ") || "-"}\n  from scratch: ${want.join(" ") || "-"}\n${where}` });
  }

  // Block index: live block_nodes equal parseBlocks of the stored body.
  for (const n of live) {
    const row = db.get(n.id)!;
    const want = [...new Map(parseBlocks(row.markdown, await validAnchors(n.id)).filter((b) => b.ref).map((b) => [b.ref!, b.kind])).entries()].map(([r, k]) => `${r}:${k}`).sort();
    const have = (await q<{ block_ref: string; kind: string }>(
      `SELECT block_ref, kind FROM block_nodes WHERE note_id = $1 AND hidden_at IS NULL`, [n.id],
    )).rows.map((r) => `${r.block_ref}:${r.kind}`).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      bad.push({ rule: "block-index", detail: `note ${n.idx}\n  block_nodes:  ${have.join(" ") || "-"}\n  from scratch: ${want.join(" ") || "-"}\n${where}` });
    }
    n.body = row.markdown;
  }
  void before;
  return bad;
}

async function applyOp(w: World, op: Op, dupOf: Map<number, string>): Promise<string | null> {
  const n = w.notes[op.note]!;
  switch (op.op) {
    case "edit":
    case "resave": {
      if (n.trashed) return null;
      let links: LinkSpec[] = [];
      if (op.op === "edit") {
        n.paras = n.paras.filter((_, i) => op.keep[i] ?? true);
        for (const a of op.add) n.paras.splice(a.at % (n.paras.length + 1), 0, { tok: `p${w.counter++}e`, tagged: a.tagged, id: null });
        if (op.paste !== null && n.paras.length) {
          const src = n.paras[op.paste % n.paras.length]!;
          if (src.id) {
            n.paras.splice(op.pasteAt % (n.paras.length + 1), 0, { tok: `${src.tok}c`, tagged: src.tagged, id: src.id });
            dupOf.set(n.idx, src.tok);
          }
        }
        links = op.links;
      }
      const { body, made } = op.op === "edit" ? renderBody(w, n, links) : { body: n.body, made: n.made };
      n.made = made;
      const res = await call("PATCH", `/api/nodes/${n.id}`, { markdown: body });
      if (res.status !== 200) throw new Error(`PATCH ${res.status}: ${res.text.slice(0, 300)}`);
      return `edit note ${n.idx}`;
    }
    case "rename": {
      if (n.trashed) return null;
      const title = op.toGhost ? ghostTitle(w) : `Renamed ${w.counter++} ${w.stamp}`;
      const res = await call("PATCH", `/api/nodes/${n.id}`, { title });
      // The same title twice in a space is refused; that is not what is under test.
      if (res.status !== 200 && res.status !== 409) throw new Error(`rename ${res.status}: ${res.text.slice(0, 300)}`);
      return `rename note ${n.idx} to ${title}`;
    }
    case "trash": {
      if (n.trashed) return null;
      const res = await call("DELETE", `/api/nodes/${n.id}`);
      if (res.status !== 200) throw new Error(`DELETE ${res.status}: ${res.text.slice(0, 300)}`);
      n.trashed = true;
      return `trash note ${n.idx}`;
    }
    case "move": {
      if (n.trashed) return null;
      const to = n.space === "A" ? spaceB : spaceA;
      const preview = await call("GET", `/api/spaces/move-preview?node=${n.id}&to=${to}`);
      if (preview.status !== 200) throw new Error(`move-preview ${preview.status}: ${preview.text.slice(0, 300)}`);
      const res = await call("POST", "/api/spaces/move", { node_id: n.id, to_space_id: to, membership_epoch: preview.body.membership_epoch });
      if (res.status !== 200) throw new Error(`move ${res.status}: ${res.text.slice(0, 300)}`);
      n.space = n.space === "A" ? "B" : "A";
      return `move note ${n.idx} to space ${n.space}`;
    }
    case "undelete": {
      if (!n.trashed) return null;
      const res = await call("POST", `/api/nodes/${n.id}/undelete`);
      if (res.status !== 200) throw new Error(`undelete ${res.status}: ${res.text.slice(0, 300)}`);
      n.trashed = false;
      return `undelete note ${n.idx}`;
    }
  }
}

let spaceA = "";
let spaceB = "";
async function newWorld(): Promise<World> {
  const stamp = randomUUID().replace(/-/g, "").slice(0, 8);
  const w: World = { notes: [], stamp, counter: 0 };
  for (let i = 0; i < N_NOTES; i++) {
    const title = `Note ${String.fromCharCode(65 + i)} ${stamp}`;
    const res = await call("POST", "/api/nodes", { space_id: i < 4 ? spaceA : spaceB, title, markdown: "" });
    if (res.status >= 300) throw new Error(`create ${res.status}: ${res.text.slice(0, 300)}`);
    w.notes.push({ idx: i, id: res.body.id, space: i < 4 ? "A" : "B", title, paras: [], made: [], trashed: false, body: "" });
  }
  return w;
}

async function runOps(ops: Op[]): Promise<Violation[]> {
  const w = await newWorld();
  const dupOf = new Map<number, string>();
  for (const [i, op] of ops.entries()) {
    const dupBefore = new Map(dupOf);
    dupOf.clear();
    const label = await applyOp(w, op, dupOf);
    if (label === null) { for (const [k, v] of dupBefore) dupOf.set(k, v); continue; }
    await settle();
    const bad = await verify(w, `step ${i + 1}: ${label} ${JSON.stringify(op)}`, new Map(), dupOf);
    if (bad.length) return bad;
  }
  return [];
}

const skip = (process.env.PROPS_SKIP ?? "").split(",").filter(Boolean);

describe.skipIf(!isTestDb)("block ids and the link index under random edits (real save route, DB)", () => {
  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Props links', $1) RETURNING id::text`, [`props-links-${randomUUID()}`])).rows[0]!.id;
    expect((await call("GET", "/api/spaces")).status).toBe(200);
    spaceA = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    const b = await call("POST", "/api/spaces", { name: "Props B" });
    expect(b.status).toBeLessThan(300);
    spaceB = b.body.id;
  });

  // A fixed script first: the comparison is only worth anything if it sees edges.
  it("a link, a rename, a trash and an undelete move the index the way the from-scratch parse says", async () => {
    const w = await newWorld();
    const link = (target: number, form = 0, ref: number | null = null): LinkSpec => ({ target, form, embed: false, ref, inCode: false });
    const edge = async (s: number, t: number) => (await q(
      `SELECT 1 FROM node_edges WHERE origin = 'wikilink' AND source_node_id = $1 AND target_node_id = $2`, [w.notes[s]!.id, w.notes[t]!.id])).rowCount;
    const step = async (op: Op) => {
      const dupOf = new Map<number, string>();
      expect(await applyOp(w, op, dupOf)).not.toBeNull();
      await settle();
      expect(await verify(w, JSON.stringify(op), new Map(), dupOf)).toEqual([]);
    };
    const edit = (note: number, links: LinkSpec[], add = 0): Op =>
      ({ op: "edit", note, keep: [], add: Array.from({ length: add }, () => ({ tagged: true, at: 0 })), paste: null, pasteAt: 0, links });

    await step(edit(1, [], 2)); // note 1 has two tagged paragraphs, so it has block ids
    await step(edit(0, [link(1), link(1, 1, 0), link(4)])); // by title, by lower-case title + block id, and into the other space
    expect(await edge(0, 1)).toBe(1);
    expect(await edge(0, 4)).toBe(0);
    await step({ op: "rename", note: 1, toGhost: false });
    expect(await edge(0, 1)).toBe(0); // links name notes, they are not rewritten
    await step({ op: "rename", note: 1, toGhost: true });
    await step(edit(0, [{ ...link(5), embed: true }])); // ![[Ghost …]]
    expect(await edge(0, 1)).toBe(1);
    await step({ op: "trash", note: 1 });
    await step(edit(0, [link(5)])); // the save drops the edge to a trashed note
    await step({ op: "undelete", note: 1 });
    expect(await edge(0, 1)).toBe(1); // and the undelete brings the backlink back
  });

  it(`edges, block index, ids and block links agree with a from-scratch parse (${process.env.PROPS_RUNS ?? "40"} runs)`, { timeout: 170_000 }, async () => {
    await checkAsync(
      fc.asyncProperty(opsArb, async (ops) => {
        const bad = (await runOps(ops)).filter((v) => !skip.includes(v.rule));
        if (bad.length) throw new Error(`${bad[0]!.rule}: ${bad[0]!.detail}`);
      }),
      // 40 runs is about 15 s; an explicit PROPS_RUNS is taken as asked.
      process.env.PROPS_RUNS ? Infinity : 40,
    );
  });

  // Shrunk by the random run from a six-step sequence (fixed). Moving a note
  // to a space where its slug is taken gets "the next free slug there"
  // (services/spaces.ts moveToSpace, `uniqueSlug(..., { spaceId: toSpaceId })`),
  // and writes that slug together with the new space_id. It used to write the
  // slug first, so the note still sat in its old space with the new slug; when
  // that slug was used in the old space the unique index (workspace, space,
  // slug) fired and the route answered 500 {"error":"internal"}.
  // Here: two notes called "Same" in space B (slugs same, same-2) and one in
  // space A (slug same). Moving B's first note to A wants "same-2" in A, which
  // is free, and trips over B's own "same-2". Same-named notes in one space
  // are allowed, so this is reachable from ordinary use.
  it("moving a note whose slug is taken in the target space does not fail with a 500", async () => {
    const s = randomUUID().replace(/-/g, "").slice(0, 8);
    const title = `Same ${s}`;
    const make = async (space: string) => {
      const res = await call("POST", "/api/nodes", { space_id: space, title, markdown: "" });
      expect(res.status).toBeLessThan(300);
      return res.body.id as string;
    };
    await make(spaceA);
    const firstB = await make(spaceB);
    await make(spaceB);
    const preview = await call("GET", `/api/spaces/move-preview?node=${firstB}&to=${spaceA}`);
    const res = await call("POST", "/api/spaces/move", { node_id: firstB, to_space_id: spaceA, membership_epoch: preview.body.membership_epoch });
    expect(res.status).toBe(200);
  });
});
