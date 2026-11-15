// Random workspaces against the front half of the publishing rule: what the
// published pages and the studio's canvas draw never contains a note the owner
// did not publish. (The back half, what the server freezes and serves, is
// backend/src/test/properties/publishRedaction.property.integration.test.ts.)
//
// World: notes numbered 0..n, each with a title, a slug and a body made of its
// own marker words (`zq07b`), so any leak is a plain substring. Some notes are
// published, the rest are not (never marked, marked but in a space that cannot
// publish). The bodies link to every note in every written form: [[Title]],
// [[Title|alias]], [[slug]], [[Title#^blk]], [[Title#Heading]], ![[Title]].
// The home page points note blocks at published and unpublished notes alike.
//
// Invariants (the names in a failure message):
//   page-body    the published home page and every published article draw no body word and no
//                slug of an unpublished note, and no unpublished note's title in an attribute
//                (an href, a title, a data-*)
//   link-text    a link to a note the site does not serve is plain text: no <a>, the words the
//                author wrote are still there; a link to a published note stays an anchor to
//                its served path
//   block        a home block that points at an unpublished note draws nothing (published site)
//   canvas       the studio's canvas data (buildEditorMeta) holds exactly the published notes
//                (and the 「一起發布」 ones), never a body, a slug or a row of any other note;
//                an unpublished note it points at shows as its title and 「未發布」, nothing more
//   closed       a note in a space that cannot publish is never drawn, even when it is marked
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npm run test:props -- siteRedaction

import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Render } from "@puckeditor/core/rsc";
import { loadAllEnhancers } from "@onden/markdown";
import { createPuckConfig, type SiteRenderMeta } from "@onden/site/react";
import { legacyDesignOf, type PuckComponentData } from "@onden/site";
import { ArticleFrame, HomeBody } from "../../components/siteFrame/SiteFrames";
import { makeSiteMarkdown } from "../../components/siteFrame/siteMarkdown";
import { readSiteData, type SiteSnapshot } from "../../components/siteFrame/siteModel";
import type { PublishedNode } from "../../components/templates/publishedCore";
import { blockedNotes, buildEditorMeta, studioNotes } from "../../modules/website/studio/editorData";
import { node as contentNode, published as publishedAttrs } from "../../modules/website/studio/fixtures";
import type { Space } from "../../lib/spaces";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

beforeAll(async () => { await loadAllEnhancers(); });

const PROPS_TIMEOUT_MS = Math.max(10_000, PROPS_RUNS * 60);
// Each test runs one fc.assert. A machine slower than the 60 ms-per-run budget above (a 2-core CI runner) stops
// after 60% of the test's time limit and passes on the cases it got through, instead of timing out; a normal machine
// finishes all PROPS_RUNS long before this and checks exactly what it did. Same device as the sync simulators'
// interruptAfterTimeLimit (syncFaultSimulation.integration.property.test.ts).
const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS, interruptAfterTimeLimit: Math.floor(PROPS_TIMEOUT_MS * 0.6) };

// ── the world ───────────────────────────────────────────────────────────────

type Status = "published" | "draft" | "closed";
type Note = { n: number; status: Status; title: string; slug: string; body: string; bodyWord: string; titleWord: string; slugWord: string; pieces: Piece[] };
type Piece =
  | { kind: "text"; text: string }
  | { kind: "link"; form: "title" | "alias" | "slug" | "block" | "heading" | "embed"; target: number; alias: string };

const pad = (n: number) => String(n).padStart(2, "0");
const wordsArb = fc.array(fc.constantFrom("你好", "世界", "テスト", "한글", "😀", "hello", "é", "a-b", "x"), { maxLength: 4 }).map((w) => w.join(" "));
const pieceArb = (count: number): fc.Arbitrary<Piece> => fc.oneof(
  { weight: 2, arbitrary: wordsArb.map((text): Piece => ({ kind: "text", text })) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("link" as const),
      form: fc.constantFrom("title" as const, "alias" as const, "slug" as const, "block" as const, "heading" as const, "embed" as const),
      target: fc.nat({ max: count - 1 }),
      alias: fc.constantFrom("看這裡", "see here", "😀", "alias"),
    }),
  },
);

const worldArb = fc.integer({ min: 2, max: 7 }).chain((count) =>
  fc.tuple(
    fc.array(fc.constantFrom<Status>("published", "published", "draft", "closed"), { minLength: count, maxLength: count }),
    fc.array(fc.array(pieceArb(count), { maxLength: 6 }), { minLength: count, maxLength: count }),
  ).map(([statuses, pieces]): Note[] => statuses.map((status, n) => ({
    n, status, pieces: pieces[n]!,
    title: `題zq${pad(n)}t`, titleWord: `zq${pad(n)}t`,
    slug: `zq${pad(n)}s`, slugWord: `zq${pad(n)}s`,
    bodyWord: `zq${pad(n)}b`,
    body: "",
  }))).map((notes) => {
    for (const note of notes) {
      const text = note.pieces.map((p) => {
        if (p.kind === "text") return p.text;
        const to = notes[p.target]!;
        switch (p.form) {
          case "title": return `[[${to.title}]]`;
          case "alias": return `[[${to.title}|${p.alias}]]`;
          case "slug": return `[[${to.slug}]]`;
          case "block": return `[[${to.title}#^blk]]`;
          case "heading": return `[[${to.title}#Heading]]`;
          case "embed": return `![[${to.title}]]`;
        }
      }).join("\n\n");
      note.body = `# ${note.title}\n\n${note.bodyWord} 這是第 ${note.n} 篇。\n\n## Heading\n\n${text}\n\n段落 ^blk`;
    }
    return notes;
  }));

const isPublished = (note: Note) => note.status === "published";
const servedNode = (note: Note): PublishedNode => ({
  id: `id${pad(note.n)}`, node_type: "content", title: note.title, slug: note.slug, markdown: note.body, created_at: "2026-02-03T04:00:00Z",
});

/** Home blocks: note blocks over any note (display modes, with and without a paragraph), in parts. */
const homeArb = (count: number): fc.Arbitrary<PuckComponentData[]> => {
  const block = fc.record({
    target: fc.option(fc.nat({ max: count - 1 }), { nil: null }),
    display: fc.constantFrom("full", "first", "card", "title"),
    blockId: fc.constantFrom("", "blk", "nope"),
  });
  return fc.array(fc.record({ type: fc.constantFrom("stack", "cards", "center", "cover", "sidebar"), blocks: fc.array(block, { minLength: 1, maxLength: 3 }) }), { minLength: 1, maxLength: 4 }).map((parts) => {
    let n = 0;
    return parts.map(({ type, blocks }): PuckComponentData => {
      const items = blocks.map((b) => ({
        type: "note",
        props: { id: `nb${n++}`, noteId: b.target === null ? "" : `id${pad(b.target)}`, blockId: b.blockId, display: b.display },
      }));
      const props: PuckComponentData["props"] = { id: `p${n++}`, bg: "none", heading: "auto", cls: "", css: "" };
      if (type === "sidebar") { props.aside = items.slice(0, 1); props.main = items.slice(1); } else props.items = items;
      return { type, props };
    });
  });
};

const snapshotOf = (notes: Note[], home: PuckComponentData[]): SiteSnapshot => {
  const served = notes.filter(isPublished);
  return {
    title: "site", home_node_id: null,
    payload: {
      nodes: served.map(servedNode),
      edges: served.flatMap((a) => served.filter((b) => b.n !== a.n && a.pieces.some((p) => p.kind === "link" && p.target === b.n)).map((b) => ({
        source_node_id: `id${pad(a.n)}`, target_node_id: `id${pad(b.n)}`, edge_type: "knowledge_link" as const,
      }))),
      presentation: { site: {}, design: { v: 2, rev: "r", home: { root: { props: {} }, content: home }, resolved: {}, tag_pages: {}, tag_names: {} } },
    },
  };
};

// ── checking an output ──────────────────────────────────────────────────────

/** Whether a published note's own text spells this note's slug, as `[[slug]]`. */
const slugTyped = (notes: readonly Note[], note: Note) => notes.some((other) => isPublished(other) && other.body.includes(`[[${note.slugWord}`));

/** The unpublished notes' words that must not appear anywhere in `html`. */
function expectNoLeak(html: string, notes: readonly Note[], where: string) {
  for (const note of notes.filter((n) => !isPublished(n))) {
    expect(html, `page-body: ${where}: body of note ${note.n} (${note.status})`).not.toContain(note.bodyWord);
    // A slug the author typed as [[slug]] is theirs to show as the link's words.
    if (!slugTyped(notes, note)) expect(html, `page-body: ${where}: slug of note ${note.n}`).not.toContain(note.slugWord);
    expect([...html.matchAll(/<[a-z][^>]*>/g)].filter((m) => m[0].includes(note.slugWord)), `page-body: ${where}: slug of note ${note.n} in an attribute`).toEqual([]);
    expect(html, `page-body: ${where}: id of note ${note.n}`).not.toContain(`id${pad(note.n)}`);
    // The title may stay as the words of a link the author wrote, but never in a tag's attribute.
    const attributes = [...html.matchAll(/<[a-z][^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(note.titleWord));
    expect(attributes, `page-body: ${where}: title of note ${note.n} in an attribute`).toEqual([]);
  }
}

const html = (node: ReactNode) => renderToStaticMarkup(node as never);

// ── published pages ─────────────────────────────────────────────────────────

describe("published pages never draw a note that is not published", { timeout: PROPS_TIMEOUT_MS }, () => {
  it("page-body + block: the home page and every article", () => {
    fc.assert(fc.property(worldArb.chain((notes) => homeArb(notes.length).map((home) => ({ notes, home }))), ({ notes, home }) => {
      const data = readSiteData(snapshotOf(notes, home));
      const homeHtml = html(createElement(HomeBody, { data }));
      expectNoLeak(homeHtml, notes, "home");
      for (const served of data.nodes) expectNoLeak(html(createElement(ArticleFrame, { data, node: served })), notes, `article ${served.slug}`);

      // block: a note block pointing at an unpublished note draws no element of its own
      const unpublished = new Set(notes.filter((n) => !isPublished(n)).map((n) => `id${pad(n.n)}`));
      const ids = new Set<string>();
      const collect = (list: PuckComponentData[]) => list.forEach((c) => {
        if (c.type === "note" && unpublished.has(String(c.props.noteId))) ids.add(c.props.id);
        for (const key of ["items", "aside", "main"]) if (Array.isArray(c.props[key])) collect(c.props[key] as PuckComponentData[]);
      });
      collect(home);
      for (const id of ids) expect(homeHtml, `block: ${id}`).not.toContain(`data-node="${id}"`);
    }), fcOpts);
  });

  it("link-text: links to notes the site does not serve are plain text; links to published notes are anchors", () => {
    fc.assert(fc.property(worldArb, fc.constantFrom("title", "alias", "slug", "block", "heading", "embed"), fc.nat({ max: 20 }), (notes, form, pick) => {
      const served = notes.filter(isPublished).map(servedNode);
      const target = notes[pick % notes.length]!;
      const label = "看這裡";
      const body = {
        title: `[[${target.title}]]`, alias: `[[${target.title}|${label}]]`, slug: `[[${target.slug}]]`,
        block: `[[${target.title}#^blk]]`, heading: `[[${target.title}#Heading]]`, embed: `![[${target.title}]]`,
      }[form];
      const out = html(makeSiteMarkdown(served)(`前 ${body} 後`));
      if (!isPublished(target)) {
        expect(out, "link-text: no anchor at all").not.toContain("<a");
        if (form !== "slug") expect(out, "link-text: no slug").not.toContain(target.slugWord);
        expect(out, "link-text: no id").not.toContain(`id${pad(target.n)}`);
        expect(out, "link-text: the author's words are still there").toMatch(form === "alias" ? new RegExp(label) : new RegExp(form === "slug" ? target.slugWord : target.titleWord));
      } else if (form !== "embed") {
        expect(out, "link-text: an anchor to the served path").toContain(`href="/site/${target.slug}`);
      }
    }), fcOpts);
  });
});

// ── the studio's canvas ─────────────────────────────────────────────────────

const personal = { id: "sp-closed", kind: "personal", is_default: false, name: "me", capabilities: { publish: false } } as unknown as Space;
const everyone = { id: "sp-open", kind: "shared", is_default: true, name: "all", capabilities: { publish: true } } as unknown as Space;

describe("the studio's canvas data holds only what would be published", { timeout: PROPS_TIMEOUT_MS }, () => {
  it("canvas + closed: notes, rows, drafts and the 「未發布」 placeholder", () => {
    fc.assert(fc.property(worldArb.chain((notes) => fc.tuple(fc.constant(notes), homeArb(notes.length))), ([notes, home]) => {
      const nodes = notes.map((n) => contentNode({
        id: `id${pad(n.n)}`, title: n.title, slug: n.slug, markdown: n.body,
        // a draft is kept off (「不發布」: its space publishes); the others are marked, a closed-space note too
        attrs: n.status === "draft" ? { _published: "false" } : publishedAttrs,
        space_id: n.status === "closed" ? personal.id : everyone.id,
        label_tag_ids: ["tg"],
      }));
      const spaces = [personal, everyone];
      const list = studioNotes(nodes, spaces);
      const design = legacyDesignOf(readSiteData(snapshotOf(notes, home)).design);
      const meta = buildEditorMeta({ nodes, tags: [{ id: "tg", name: "文章", color: null, schema_id: "tg" } as never], notes: list, design, renderMarkdown: (md) => md, bodies: undefined });

      const onSite = new Set(notes.filter(isPublished).map((n) => `id${pad(n.n)}`));
      expect(Object.keys(meta.notes).sort(), "canvas: exactly the published notes").toEqual([...onSite].sort());
      const everything = JSON.stringify({ notes: meta.notes, resolved: meta.resolved, tagNames: meta.tagNames });
      for (const note of notes.filter((n) => !isPublished(n))) {
        expect(everything, `canvas: body of note ${note.n} (${note.status})`).not.toContain(note.bodyWord);
        if (!slugTyped(notes, note)) expect(everything, `canvas: slug of note ${note.n}`).not.toContain(note.slugWord);
      }
      // closed: marked, yet never listed and never blocked-as-publishable
      for (const note of notes.filter((n) => n.status === "closed")) {
        expect(list.map((x) => x.id), "closed: not in the studio's lists").not.toContain(`id${pad(note.n)}`);
        expect(Object.keys(meta.notes)).not.toContain(`id${pad(note.n)}`);
      }
      expect(blockedNotes(nodes, spaces).map((b) => b.id).sort(), "closed: the publish dialog names exactly them").toEqual(notes.filter((n) => n.status === "closed").map((n) => `id${pad(n.n)}`).sort());

      // the placeholder: a draft shows its title only
      const canvas = html(createElement(Render, { config: createPuckConfig(), data: design.home as never, metadata: meta as SiteRenderMeta }));
      for (const note of notes.filter((n) => !isPublished(n))) {
        expect(canvas, `canvas: body of note ${note.n} on the canvas`).not.toContain(note.bodyWord);
        if (!slugTyped(notes, note)) expect(canvas, `canvas: slug of note ${note.n} on the canvas`).not.toContain(note.slugWord);
      }
      const pointsAtDraft: string[] = [];
      const scan = (list: PuckComponentData[]) => list.forEach((c) => {
        if (c.type === "note" && c.props.noteId && !onSite.has(String(c.props.noteId))) pointsAtDraft.push(c.props.id);
        for (const key of ["items", "aside", "main"]) if (Array.isArray(c.props[key])) scan(c.props[key] as PuckComponentData[]);
      });
      scan(design.home.content);
      for (const id of pointsAtDraft) expect(canvas, `canvas: the block ${id} shows 「未發布」`).toMatch(new RegExp(`data-node="${id}"[^>]*>(?:<span[^>]*>[^<]*</span>)?<?[^]*?未發布`));
      for (const draft of Object.keys(meta.drafts ?? {})) expect(Object.keys(meta.drafts![draft]!), "canvas: a draft is a title").toEqual(["title"]);
    }), fcOpts);
  });

  it("canvas: 「一起發布」 shows the chosen notes as published, and only those", () => {
    fc.assert(fc.property(worldArb, fc.array(fc.nat({ max: 20 }), { maxLength: 4 }), (notes, picks) => {
      // All kept off (「不發布」) until 「一起發布」 picks some.
      const nodes = notes.map((n) => contentNode({ id: `id${pad(n.n)}`, title: n.title, slug: n.slug, markdown: n.body, attrs: { _published: "false" }, space_id: everyone.id }));
      const also = new Set(picks.map((p) => `id${pad(p % notes.length)}`));
      const design = legacyDesignOf(readSiteData(snapshotOf(notes, [])).design);
      const meta = buildEditorMeta({ nodes, tags: [], notes: studioNotes(nodes, [everyone]), design, alsoPublished: also, renderMarkdown: (md) => md });
      expect(Object.keys(meta.notes).sort()).toEqual([...also].sort());
    }), fcOpts);
  });
});
