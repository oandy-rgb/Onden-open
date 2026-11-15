// Property test of the publishing rule: nothing the owner did not publish
// reaches the public output.
//
// Each run builds a random workspace through the real routes (a tree of
// published, kept-off and private-space notes; wikilinks, piped links, block
// refs and embeds between them; query / base blocks over a shared tag; tags,
// attributes, aliases, uploaded files and canvases), publishes it through
// POST /api/publish, and collects every public artifact the backend produces:
//   - the snapshot payload (publish_snapshots, what the publish froze),
//   - GET /api/site (served site, read anonymously) and GET /api/site/url/:id,
//   - the static export zip (GET /api/export-static: every file name and byte),
//   - the files the static host push would send (performPagesPush: the same static copy — pages,
//     sitemap.xml, feed.xml, robots.txt, 404.html, bundled media; the pages come from
//     a stand-in for the frontend that reads the served site),
//   - /api/media/<file>, fetched anonymously.
// There is no RSS or search-index generator in the backend; the sitemap is
// the only feed-like file.
//
// Every title, slug, body, attribute, alias, block id, tag name, file name,
// file content and id of a private thing is a unique lowercase marker; the
// artifacts are scanned byte for byte (names, JSON keys, base64 data: URIs
// decoded) for any marker that must not be public. Then published notes are
// taken down (unpublished, trashed, moved to a private space) and the same
// scan runs on what is served immediately and on the next publish.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n>. A failure prints the seed and
// fast-check's shrunk spec.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { slugify } from "@onden/markdown";
import { pool, q } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import nodesRouter from "../../routes/nodes.js";
import tagsRouter from "../../routes/tags.js";
import mediaRouter from "../../routes/media.js";
import canvasesRouter from "../../routes/canvases.js";
import publishRouter from "../../modules/website/routes.js";
import { moveToSpace } from "../../services/spaces.js";
import { markAsTask } from "../helpers/taskRef.js";
import { MEDIA_DIR } from "../../services/mediaStore.js";
import { performPagesPush } from "../../modules/website/publishing/pagesPush.js";
import { startFakeRenderer } from "../helpers/fakeRenderer.js";
import type { BundleFile } from "../../modules/website/publishing/githubPages.js";
import type { ActorCtx } from "../../types.js";
import { checkAsync, PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { zipEntries } from "../helpers/zipEntries.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { seedQ } from "../helpers/seedQ.js";

registerShippedModules();

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test(\?|$)/.test(database);

let workspaceId = "";
let currentActor: ActorCtx | null = null;
let pushed: BundleFile[] | null = null;
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceId }));
// The static host push, captured instead of sent: the files it would deploy.
vi.mock("../../modules/website/publishing/githubPages.js", async (original) => ({
  ...await original<typeof import("../../modules/website/publishing/githubPages.js")>(),
  pushToGitHubPages: async (files: BundleFile[]) => { pushed = files; },
}));

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/media", mediaRouter);
app.route("/api/canvases", canvasesRouter);
app.route("/api", publishRouter);

// ── The generated workspace ──────────────────────────────────────────────────

// taskRef / taskEmbed / taskTitle point at a task (a hidden #task node, T6): by id
// (`[[onden://node/<id>|label]]`, `![[onden://node/<id>]]`) or by its title.
type LinkForm = "wiki" | "piped" | "heading" | "block" | "embed" | "blockEmbed" | "alias" | "slug" | "taskRef" | "taskEmbed" | "taskTitle";
type NoteState = "published" | "kept_off" | "private_space";
type Media = "none" | "own_txt" | "own_img" | "borrow";
type NoteSpec = {
  state: NoteState;
  /** Picks among the earlier notes that share this note's space. */
  parentPick: number | null;
  /** `to` indexes notes then canvases (modulo). */
  links: Array<{ to: number; form: LinkForm }>;
  /** 0, 1: shared tags; 2, 3: tags only private notes carry. */
  tags: number[];
  media: Media;
  alias: boolean;
  block: boolean;
  query: "none" | "query" | "base";
};
type Takedown = { pick: number; op: "unpublish" | "trash" | "move" };
/** What the owner's publish request names by note index: the home override and
 *  the nav link, page layout and page blocks of the site design. */
type DesignRefs = { home: number | null; nav: number | null; layout: number | null; pageBlocks: number | null; blocks: boolean };
type Spec = { notes: NoteSpec[]; canvases: Array<"pub_space" | "priv_space">; takedowns: Takedown[]; design: DesignRefs };

const FORMS: LinkForm[] = ["wiki", "piped", "heading", "block", "embed", "blockEmbed", "alias", "slug", "taskRef", "taskEmbed", "taskTitle"];
const noteArb: fc.Arbitrary<NoteSpec> = fc.record({
  state: fc.constantFrom<NoteState>("published", "published", "kept_off", "private_space"),
  parentPick: fc.option(fc.nat(10), { nil: null }),
  links: fc.array(fc.record({ to: fc.nat(20), form: fc.constantFrom(...FORMS) }), { maxLength: 3 }),
  tags: fc.uniqueArray(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }),
  media: fc.constantFrom<Media>("none", "none", "own_txt", "own_img", "borrow"),
  alias: fc.boolean(),
  block: fc.boolean(),
  query: fc.constantFrom<NoteSpec["query"]>("none", "none", "query", "base"),
});
const specArb: fc.Arbitrary<Spec> = fc.record({
  notes: fc.array(noteArb, { minLength: 2, maxLength: 6 }),
  canvases: fc.array(fc.constantFrom<"pub_space" | "priv_space">("pub_space", "priv_space"), { maxLength: 2 }),
  takedowns: fc.array(fc.record({ pick: fc.nat(10), op: fc.constantFrom<Takedown["op"]>("unpublish", "trash", "move") }), { maxLength: 2 }),
  design: fc.record({
    home: fc.option(fc.nat(10), { nil: null }),
    nav: fc.option(fc.nat(10), { nil: null }),
    layout: fc.option(fc.nat(10), { nil: null }),
    pageBlocks: fc.option(fc.nat(10), { nil: null }),
    blocks: fc.boolean(),
  }),
});

// ── Markers ──────────────────────────────────────────────────────────────────

let runCounter = 0;
/** A lowercase marker unique to (this run, kind, index). Fixed width, and a
 *  kind letter after the number, so no marker is a substring of another. */
const marker = (run: string, kind: string, i: number) => `zq${run}${kind}${String(i).padStart(2, "0")}`;

type Planned = {
  spec: NoteSpec; index: number; id: string; title: string; slug: string;
  body: string; stage: string; blockId: string; aliasMarker: string; file?: { name: string; kind: "txt" | "img"; content: string };
  /** Markers that are public while the note is on the site. */
  whileOnSite: string[];
};

// ── Artifacts ────────────────────────────────────────────────────────────────

type Item = { source: string; name: string; text: string };

/** Each item plus every base64 `data:` payload inside it, decoded. */
function withDecoded(items: Item[]): Item[] {
  const out = [...items];
  for (const item of items) {
    for (const m of item.text.matchAll(/data:[a-z0-9.+/-]+;base64,([A-Za-z0-9+/=]+)/gi)) {
      out.push({ source: `${item.source} (decoded data: URI)`, name: item.name, text: Buffer.from(m[1]!, "base64").toString("latin1") });
    }
  }
  return out;
}

const decode = (buf: Buffer) => buf.toString("latin1").toLowerCase();

async function request(actor: ActorCtx | null, url: string, init?: RequestInit): Promise<Response> {
  const before = currentActor;
  currentActor = actor;
  try { return await app.request(url, init); } finally { currentActor = before; }
}

type Collected = { items: Item[]; served: Record<string, unknown>; zip: Map<string, string>; push: Map<string, string> };

async function collect(owner: ActorCtx, label: string, snapshot: boolean): Promise<Collected> {
  const items: Item[] = [];
  const servedRes = await request(null, "/api/site");
  const servedText = await servedRes.text();
  items.push({ source: `${label}: GET /api/site`, name: "", text: servedText.toLowerCase() });
  const zipRes = await request(owner, "/api/export-static");
  const zipFiles = zipEntries(Buffer.from(await zipRes.arrayBuffer()));
  const zip = new Map<string, string>();
  for (const [name, data] of zipFiles) {
    items.push({ source: `${label}: static export`, name: name.toLowerCase(), text: decode(data) });
    zip.set(name, createHash("sha256").update(data).digest("hex"));
  }
  const last = (await q<{ id: string; payload: unknown; title: string }>(
    `SELECT id::text, payload, title FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [workspaceId])).rows[0];
  pushed = null;
  if (last) await performPagesPush({ snapshotId: last.id, workspaceId });
  const push = new Map<string, string>();
  for (const file of (pushed ?? []) as BundleFile[]) {
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content as string);
    items.push({ source: `${label}: static host push`, name: file.path.toLowerCase(), text: decode(data) });
    push.set(file.path, createHash("sha256").update(data).digest("hex"));
  }
  if (snapshot && last) items.push({ source: `${label}: snapshot payload`, name: "", text: JSON.stringify({ title: last.title, payload: last.payload }).toLowerCase() });
  if (process.env.PROPS_DEBUG) console.log(`[collect ${label}] ${items.map((i) => i.source.split(': ')[1] + ':' + (i.name || '-') + ':' + i.text.length).join(' | ')}`);
  return { items: withDecoded(items), served: JSON.parse(servedText) as Record<string, unknown>, zip, push };
}

/** The markers found in any artifact: "<marker> in <source> (<file>)". */
function leaks(items: Item[], markers: Map<string, string>, nameOnly: Set<string>): string[] {
  const found = new Set<string>();
  for (const item of items) {
    for (const [m, what] of markers) {
      const inName = item.name.includes(m);
      const inText = !nameOnly.has(m) && item.text.includes(m);
      if (inName || inText) found.add(`${what}${/^[0-9a-f-]{36}$/.test(m) ? " [its id]" : ""} leaked into ${item.source}${inName ? ` (file name ${item.name})` : ""}`);
    }
  }
  return [...found];
}

// ── One scenario ─────────────────────────────────────────────────────────────

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const j = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Builds the workspace of `spec`, publishes it, takes notes down, and returns
 *  every way the public output broke the rule (empty = it held). */
async function runScenario(specIn: Spec): Promise<string[]> {
  const spec: Spec = structuredClone(specIn);
  if (!spec.notes.some((n) => n.state === "published")) spec.notes[0]!.state = "published";
  const run = (++runCounter).toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
  const problems: string[] = [];
  const mediaFiles: string[] = [];
  const uploaded = new Map<string, string>();

  workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Redaction property', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
  const owner = await persistActor(workspaceId, { id: "", name: "Owner", role: "admin", type: "human" });
  const pubSpace = await makeSpace(workspaceId, `pub-${run}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
  const privSpace = await makeSpace(workspaceId, `priv-${run}`, [{ id: owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
  const call = async (method: string, url: string, body?: unknown, expect = [200, 201]): Promise<Record<string, unknown>> => {
    const res = await request(owner, url, body === undefined ? { method } : { ...j(body), method });
    const text = await res.text();
    if (!expect.includes(res.status)) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  };
  // Previewed first, as the app does: the publish route takes only a hash from a preview.
  const publishWith = async (body: Record<string, unknown>) => {
    const { hash } = await call("POST", "/api/publish/preview", body, [200]) as { hash: string };
    await call("POST", "/api/publish", { ...body, preview_hash: hash }, [201]);
  };

  try {
    // never-public markers, the thing they belong to, and files only a name check applies to
    const never = new Map<string, string>();
    const nameOnly = new Set<string>();
    const forbid = (m: string, what: string) => { never.set(m, what); };

    // tags: 0, 1 shared; 2, 3 only on private notes
    const tagIds: string[] = [];
    const tagNames = [`topic-a-${run}`, `topic-b-${run}`, marker(run, "p", 2), marker(run, "p", 3)];
    for (let t = 0; t < 4; t++) {
      tagIds.push(String((await call("POST", "/api/tags", { name: tagNames[t] })).id));
      if (t >= 2) { forbid(tagNames[t]!, "private-only tag name"); forbid(tagIds[t]!, "private-only tag id"); }
    }

    // canvases: always private (never opted in), titled with a marker
    const canvases: Array<{ id: string; title: string }> = [];
    for (let c = 0; c < spec.canvases.length; c++) {
      const title = marker(run, "n", c);
      const made = await call("POST", "/api/canvases", { title, space_id: spec.canvases[c] === "pub_space" ? pubSpace : privSpace });
      canvases.push({ id: String(made.id), title });
      forbid(title, "canvas title"); forbid(String(made.id), "canvas id");
    }

    // plan: titles and ids are known before any body is written
    const planned: Planned[] = spec.notes.map((spec, index) => {
      const title = `Note ${marker(run, "t", index)}`;
      const priv = spec.state !== "published";
      const p: Planned = {
        spec, index, id: randomUUID(), title, slug: slugify(title), body: marker(run, "b", index), stage: marker(run, "v", index),
        blockId: marker(run, "k", index), aliasMarker: marker(run, "a", index), whileOnSite: [],
      };
      if (spec.media === "own_txt" || spec.media === "own_img") {
        p.file = { name: "", kind: spec.media === "own_txt" ? "txt" : "img", content: marker(run, "c", index) };
      }
      const own = [marker(run, "t", index), p.slug, p.body, p.stage, p.id, ...(spec.block ? [p.blockId] : [])];
      if (priv) {
        for (const m of own) forbid(m, `private note ${index} (${spec.state})`);
        if (spec.alias) forbid(p.aliasMarker, `alias of private note ${index}`);
        forbid(marker(run, "x", index), `attribute key of private note ${index}`);
        forbid(marker(run, "y", index), `attribute value of private note ${index}`);
        if (p.file) forbid(p.file.content, `file content of private note ${index}`);
      } else {
        p.whileOnSite.push(...own);
        if (p.file) p.whileOnSite.push(p.file.content);
      }
      return p;
    });
    // tasks: standalone hidden #task nodes in the publishing space, never published
    const tasks: Array<{ id: string; title: string; slug: string }> = [];
    for (let k = 0; k < 2; k++) {
      const id = randomUUID();
      const title = `Task ${marker(run, "s", k)}`;
      const slug = `task-${id}`;
      await seedQ(
        `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, hidden, space_id)
         VALUES ($1,$2,'manual','content',$3,$4,'',true,$5)`, [id, workspaceId, title, slug, k === 0 ? pubSpace : privSpace]);
      await markAsTask(workspaceId, id);
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source) VALUES ($1,$2,'_task_status','todo','text',false,'ui')`, [workspaceId, id]);
      tasks.push({ id, title, slug });
      for (const m of [marker(run, "s", k), id, slug]) forbid(m, `task ${k}`);
    }
    const targets = [...planned.map((p) => ({ title: p.title, slug: p.slug, id: p.id, note: p as Planned | null, aliasMarker: p.aliasMarker, blockId: p.blockId, isTask: false })),
      ...canvases.map((c) => ({ title: c.title, slug: slugify(c.title), id: c.id, note: null, aliasMarker: "", blockId: "", isTask: false })),
      ...tasks.map((k) => ({ title: k.title, slug: k.slug, id: k.id, note: null, aliasMarker: "", blockId: "", isTask: true }))];
    const privateAtPublish = (t: (typeof targets)[number]) => t.note === null || t.note.spec.state !== "published";

    // creation, in order: parents before children
    let linkCount = 0;
    const expectsPlaceholder: Array<{ from: Planned; text: string }> = [];
    for (const p of planned) {
      const s = p.spec;
      const sameSpace = planned.slice(0, p.index).filter((e) => (e.spec.state === "private_space") === (s.state === "private_space"));
      const parent = s.parentPick !== null && sameSpace.length > 0 ? sameSpace[s.parentPick % sameSpace.length]! : null;
      const lines = [`# ${p.title}`, "", s.block ? `Body ${p.body} ^${p.blockId}` : `Body ${p.body}`, ""];
      for (const link of s.links) {
        let to = link.to % targets.length;
        if (to === p.index) to = (to + 1) % targets.length;
        const t = targets[to]!;
        let form = link.form;
        if (t.note === null && (form === "block" || form === "blockEmbed")) form = "heading";
        // The task forms need a task; a task takes only forms that make sense for one.
        if (!t.isTask && (form === "taskRef" || form === "taskEmbed" || form === "taskTitle")) form = "wiki";
        if (t.isTask && (form === "heading" || form === "alias")) form = "wiki";
        if (form === "alias" && !(t.note && t.note.spec.alias && t.note.spec.state !== "published")) form = "wiki";
        const label = `lbl${run}${linkCount++}`;
        const text = {
          wiki: `[[${t.title}]]`, piped: `[[${t.title}|${label}]]`, heading: `[[${t.title}#Intro]]`,
          block: `[[${t.title}#^${t.blockId}]]`, embed: `![[${t.title}]]`, blockEmbed: `![[${t.title}#^${t.blockId}]]`,
          alias: `[[${t.aliasMarker}]]`, slug: `[[${t.slug}]]`,
          taskRef: `[[onden://node/${t.id}|${label}]]`, taskEmbed: `![[onden://node/${t.id}]]`, taskTitle: `![[${t.title}]]`,
        }[form];
        lines.push(`See ${text}`, "");
        if (s.state === "published" && privateAtPublish(t)) expectsPlaceholder.push({ from: p, text: form === "piped" || form === "taskRef" ? label : "(private)" });
      }
      if (s.query === "query") lines.push("```onden-query", `tags: ${tagNames[0]}`, "sort: title", "```", "");
      if (s.query === "base") {
        lines.push("```onden-base", "filters:", `  - 'file.hasTag("${tagNames[0]}")'`, "views:", "  - type: table", "    order: [file.name, stage]", "```", "");
      }
      // media: an own file uploaded for this note, or a private note's file
      let ref: { name: string; kind: "txt" | "img" } | null = null;
      if (p.file) {
        const form = new FormData();
        const ext = p.file.kind === "txt" ? "txt" : "png";
        form.set("file", new File([p.file.kind === "txt" ? Buffer.from(p.file.content) : PNG], `up.${ext}`, { type: p.file.kind === "txt" ? "text/plain" : "image/png" }));
        const res = await request(owner, "/api/media", { method: "POST", body: form });
        if (res.status !== 200) throw new Error(`upload -> ${res.status} ${await res.text()}`);
        p.file.name = String(((await res.json()) as { url: string }).url).split("/").pop()!;
        mediaFiles.push(p.file.name);
        uploaded.set(p.file.name, p.file.content);
        ref = { name: p.file.name, kind: p.file.kind };
        if (s.state !== "published") forbid(p.file.name, `file name of private note ${p.index}`); else p.whileOnSite.push(p.file.name);
      } else if (s.media === "borrow") {
        const owned = planned.slice(0, p.index).find((e) => e.file && e.spec.state !== "published");
        if (owned) {
          ref = { name: owned.file!.name, kind: owned.file!.kind };
          if (s.state === "published") nameOnly.add(owned.file!.name); // typed into a published body by the owner: only the file itself is checked
        }
      }
      if (ref) lines.push(ref.kind === "img" ? `![pic](/api/media/${ref.name})` : `[file](/api/media/${ref.name})`, "");
      const attributes: Array<{ key: string; value: string; value_type?: string }> = [{ key: "stage", value: p.stage, value_type: "text" }];
      if (s.state !== "published") {
        attributes.push({ key: marker(run, "x", p.index), value: marker(run, "y", p.index), value_type: "text" });
        if (s.alias) attributes.push({ key: "aliases", value: p.aliasMarker, value_type: "text" });
      }
      const tag_ids = s.tags.filter((t) => s.state !== "published" || t < 2).map((t) => tagIds[t]!);
      const made = await call("POST", "/api/nodes", {
        id: p.id, title: p.title, markdown: lines.join("\n"),
        ...(parent ? { parent_id: parent.id } : { space_id: s.state === "private_space" ? privSpace : pubSpace }),
        tag_ids, attributes,
      });
      if (made.id !== p.id) throw new Error("note id not kept");
      if (s.state === "published") await call("PUT", `/api/nodes/${p.id}/attributes/_published`, { value: true, value_type: "bool" });
      else if (s.state === "kept_off") await call("PUT", `/api/nodes/${p.id}/attributes/_published`, { value: false, value_type: "bool" }); // 「不發布」: its space publishes, this note stays off
    }

    // ── publish, twice: same state, same public output ────────────────────────
    const noteId = (pick: number | null) => pick === null ? null : planned[pick % planned.length]!.id;
    const d = spec.design;
    const publishBody = {
      title: "Redaction site",
      ...(d.home !== null ? { home_node_id: noteId(d.home) } : {}),
      presentation: {
        template: "clean-docs",
        site: { brand: "Redaction site", ...(d.nav !== null ? { nav: [{ label: "Go", nodeId: noteId(d.nav) }] } : {}) },
        ...(d.layout !== null ? { pageLayouts: { [noteId(d.layout)!]: { layout: "narrow" } } } : {}),
        ...(d.pageBlocks !== null ? { pageBlocks: { [noteId(d.pageBlocks)!]: [{ id: "pb1", type: "markdown", props: { content: "hello" } }] } } : {}),
        ...(d.blocks ? { blocks: [{ id: "b1", type: "site_nav" }, { id: "b2", type: "markdown", props: { content: "hello" } }] } : {}),
      },
    };
    await publishWith(publishBody);
    const first = await collect(owner, "publish", true);
    problems.push(...leaks(first.items, never, nameOnly).map((m) => `after publish: ${m}`));

    // controls: the scan can see a published page, and a private-link becomes the placeholder
    const sitePayload = first.served.payload as { nodes?: Array<{ id: string; markdown: string }> } | undefined;
    const onSite = new Map((sitePayload?.nodes ?? []).map((n) => [n.id, n.markdown]));
    for (const p of planned.filter((e) => e.spec.state === "published")) {
      if (!onSite.has(p.id)) problems.push(`control: published note ${p.index} is not on the served site`);
    }
    for (const { from, text } of expectsPlaceholder) {
      const md = onSite.get(from.id);
      if (md !== undefined && !md.includes(text)) problems.push(`link from published note ${from.index} to a private note is neither plain text nor the placeholder (expected "${text}")`);
    }
    for (const p of planned.filter((e) => e.spec.state === "published")) {
      const md = onSite.get(p.id);
      if (md !== undefined) {
        for (const q2 of [/\[\[[^\]]*\]\]/g]) {
          for (const m of md.matchAll(q2)) {
            const bad = [...never.keys()].find((k) => m[0].toLowerCase().includes(k));
            if (bad) problems.push(`link in published note ${p.index} still names a private marker (${never.get(bad)})`);
          }
        }
      }
    }
    // private-only tags never appear as chips; frozen query lists name published rows only (the scan covers both)

    await publishWith(publishBody);
    const second = await collect(owner, "second publish", true);
    problems.push(...leaks(second.items, never, nameOnly).map((m) => `after second publish: ${m}`));
    const strip = (c: Collected) => JSON.stringify({ title: c.served.title, home: c.served.home_node_id, payload: c.served.payload });
    if (strip(first) !== strip(second)) problems.push("publishing the same state twice changed the served site");
    for (const [kind, a, b] of [["static export", first.zip, second.zip], ["static host push", first.push, second.push]] as const) {
      const names = new Set([...a.keys(), ...b.keys()]);
      const differing = [...names].filter((n) => a.get(n) !== b.get(n));
      if (differing.length > 0) problems.push(`publishing the same state twice changed the ${kind}: ${differing.slice(0, 3).join(", ")}`);
    }

    // anonymous media: nothing private is served; a published note's own file is
    for (const p of planned) {
      if (!p.file) continue;
      const res = await request(null, `/api/media/${p.file.name}`);
      if (p.spec.state !== "published" && res.status !== 404) problems.push(`private file of note ${p.index} is served anonymously (${res.status})`);
      if (p.spec.state === "published" && res.status !== 200) problems.push(`control: published note ${p.index}'s own file is not served (${res.status})`);
    }
    for (const owned of planned.filter((e) => e.file && e.spec.state !== "published")) {
      for (const name of [...first.zip.keys(), ...first.push.keys()]) {
        if (name.toLowerCase().includes(owned.file!.name)) problems.push(`private file of note ${owned.index} is bundled (${name})`);
      }
    }

    // ── take notes down ───────────────────────────────────────────────────────
    const onTheSite = planned.filter((p) => p.spec.state === "published");
    for (const t of spec.takedowns) {
      const target = onTheSite[t.pick % onTheSite.length]!;
      try {
        if (t.op === "unpublish") await call("PUT", `/api/nodes/${target.id}/attributes/_published`, { value: false, value_type: "bool" });
        else if (t.op === "trash") await call("DELETE", `/api/nodes/${target.id}`);
        else {
          const epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]!.e;
          await moveToSpace(owner, workspaceId, target.id, privSpace, epoch);
        }
      } catch { /* a refused takedown (e.g. moving a child) takes nothing down: the DB decides below */ }
    }
    // what is no longer on the site, from the database alone
    const state = (await q<{ id: string; gone: boolean }>(
      `SELECT n.id::text AS id,
              (n.deleted_at IS NOT NULL OR COALESCE(s.capabilities->>'publish', 'false') <> 'true'
               OR NOT EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = n.id AND a.key = '_published' AND a.value = 'true')) AS gone
         FROM content_nodes n LEFT JOIN spaces s ON s.id = n.space_id
        WHERE n.id = ANY($1::uuid[])`, [planned.map((p) => p.id)])).rows;
    const goneIds = new Set(state.filter((r) => r.gone).map((r) => r.id));
    const afterTakedown = new Map(never);
    for (const p of onTheSite.filter((e) => goneIds.has(e.id))) {
      for (const m of p.whileOnSite) afterTakedown.set(m, `note ${p.index} taken down (${p.spec.state})`);
    }
    // links to taken-down notes are not in the nameOnly set: their file names stay exempt only if a published body typed them
    const afterNameOnly = new Set(nameOnly);

    // served immediately, with no new publish
    const immediate = await collect(owner, "immediately after takedown", false);
    problems.push(...leaks(immediate.items, afterTakedown, afterNameOnly).map((m) => `${m}`));
    for (const p of onTheSite.filter((e) => goneIds.has(e.id))) {
      const url = (await call("GET", `/api/site/url/${p.id}`)) as { published_url: string | null };
      if (url.published_url !== null) problems.push(`taken-down note ${p.index} still has a public address (${url.published_url})`);
      if (p.file) {
        const res = await request(null, `/api/media/${p.file.name}`);
        if (res.status !== 404) problems.push(`taken-down note ${p.index}'s file is still served anonymously (${res.status})`);
      }
    }

    // the next publish
    await publishWith(publishBody);
    const next = await collect(owner, "publish after takedown", true);
    problems.push(...leaks(next.items, afterTakedown, afterNameOnly).map((m) => `${m}`));
    return [...new Set(problems)];
  } finally {
    for (const f of mediaFiles) await unlink(join(MEDIA_DIR, f)).catch(() => {});
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

/** Two published notes and one private-space note; `design` names notes by index. */
const withDesign = (design: Partial<DesignRefs>, takedowns: Takedown[] = []): Spec => ({
  notes: [
    { state: "published", parentPick: null, links: [], tags: [], media: "none", alias: false, block: false, query: "none" },
    { state: "published", parentPick: null, links: [], tags: [], media: "none", alias: false, block: false, query: "none" },
    { state: "private_space", parentPick: null, links: [], tags: [], media: "none", alias: false, block: false, query: "none" },
  ],
  canvases: [], takedowns,
  design: { home: null, nav: null, layout: null, pageBlocks: null, blocks: false, ...design },
});

describe.skipIf(!isTestDb)("publishing never lets unpublished content reach the public output (property)", () => {
  let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;
  beforeAll(async () => {
    // The static copy asks the frontend for each page; a stand-in answers for the run's workspace.
    renderer = await startFakeRenderer(() => workspaceId);
  });
  afterAll(async () => {
    await renderer?.close();
    await pool.end();
  });

  it("random workspaces: no private marker in the snapshot, site, export, push or media; takedowns apply at once; publishing twice is the same", async () => {
    console.log(`[publishRedaction] PROPS_SEED=${PROPS_SEED} PROPS_RUNS=${PROPS_RUNS}`);
    await checkAsync(fc.asyncProperty(specArb, async (spec) => {
      const problems = await runScenario(spec);
      expect(problems).toEqual([]);
    }), process.env.PROPS_RUNS ? Infinity : 30);
  }, 600_000);

  // Shrunk workspaces of past leaks (2026-10-24). Class: the opaque id of a note the site does
  // not serve was carried by a design reference the owner's publish request names. No title or body.
  it("a site nav link naming a private note carries that note's id into the snapshot, site and push", async () => {
    expect(await runScenario(withDesign({ nav: 2 }))).toEqual([]);
  }, 60_000);
  // Fixed by #641: a new snapshot no longer carries pageBlocks.
  it("page blocks keyed by a private note do not carry that note's id into the snapshot, site and push", async () => {
    expect(await runScenario(withDesign({ pageBlocks: 2 }))).toEqual([]);
  }, 60_000);
  it("a nav link to a note that is taken down later keeps its id on the served site until the next publish", async () => {
    expect(await runScenario(withDesign({ nav: 0 }, [{ pick: 0, op: "unpublish" }]))).toEqual([]);
  }, 60_000);
});
