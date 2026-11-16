// getSlides / setSlideLayout / listSuggestions / listChildren / listSpaces through callTool,
// against the real read scope, write authority and the tool registry (audit trail included).
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it } from "vitest";
import { pagesOf, parseSlidesData } from "@onden/markdown";
import { pool, q } from "../db.js";
import { callTool, toolsForAccess } from "../services/agentTools/index.js";
import { createNote } from "../services/noteCreate.js";
import { createSuggestions, acceptSuggestionItems, rejectSuggestionItems, suggestionsForNode } from "../services/aiSuggestions.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { AuthorityError } from "../spine/authority.js";
import { ScopeError } from "../spine/toolScope.js";
import type { ActorCtx } from "../types.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
afterAll(async () => { await pool.end(); });

const DECK = "# Plan\n\nWhat we will do\n\n---\n\n## Steps\n\n- one\n- two\n- three\n\n---\n\n## Costs\n\n- 2024 start\n- 2025 grow\n- 2026 stay\n";
const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const call = (name: string, args: unknown, actor: ActorCtx, ws: string, dryRun = false) => callTool(name, args, { actor, workspaceId: ws, dryRun });
const slidesData = async (id: string) => parseSlidesData((await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'slides_data'`, [id])).rows[0]?.value);

type Slides = NonNullable<Awaited<ReturnType<typeof callTool>>> & {
  note: { id: string }; theme: string; pageCount: number; next: number | null;
  pages: Array<{ position: number; key: string; title: string | null; layout: string; autoLayout: string; layoutChosen: boolean; screen: string; speakerNotes: string; range: { from: number; to: number } | null }>;
  layouts: Array<{ id: string }>;
};

async function world(label: string) {
  const w = await agentWorld(label, { ownWorkspace: { modules: ["ai", "slides"] } });
  const reader = await persistActor(w.ws, {
    id: "", name: `Reader ${w.stamp}`, role: "editor", type: "agent",
    tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
  });
  // A reader: in the shared space (and every other it joined) with view rights only.
  await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view') ON CONFLICT (space_id, actor_id) DO UPDATE SET permission = 'view'`, [w.space, reader.id]);
  await q(`UPDATE space_members SET permission = 'view' WHERE actor_id = $1`, [reader.id]);
  const asReader = await resolveCurrentActor({ id: reader.id, tokenScope: { tokenId: reader.tokenScope!.tokenId } }, w.ws);
  const private_ = await makeSpace(w.ws, `private ${w.stamp}`, [{ id: w.owner.id }]);
  return { ...w, reader: asReader, private_ };
}

describe("the new tools are registered with the right access", () => {
  it("reads: getSlides, listSuggestions, listChildren, listSpaces; write: setSlideLayout", () => {
    registerShippedModules();
    const read = toolsForAccess("read");
    for (const name of ["getSlides", "listSuggestions", "listChildren", "listSpaces"]) expect(read).toContain(name);
    expect(read).not.toContain("setSlideLayout");
    expect(toolsForAccess("write")).toContain("setSlideLayout");
  });
});

describe.skipIf(!isTestDb)("getSlides / setSlideLayout", () => {
  it("cuts the same pages as the app's pagesOf and reports layouts, theme and ranges", async () => {
    const w = await world("slides");
    const id = await w.note(DECK);
    const r = await call("getSlides", { id }, w.agent, w.ws) as Slides;
    const expected = pagesOf(DECK);
    expect(r.pageCount).toBe(expected.length);
    expect(r.pages.map((p) => p.key)).toEqual(expected.map((p) => p.key));
    expect(r.pages.map((p) => p.layout)).toEqual(expected.map((p) => p.autoLayout));
    expect(r.pages.every((p) => !p.layoutChosen)).toBe(true);
    expect(r.pages.map((p) => p.autoLayout)).toEqual(["cover", "three", "timeline"]);
    expect(r.theme).toBe("site");
    expect(r.layouts.map((l) => l.id)).toContain("bullets");
    // The range points back into the note's text.
    for (const p of r.pages) expect(DECK.slice(p.range!.from, p.range!.to)).toContain(p.title ?? "");
    expect(r.pages[0]!.screen).toContain("# Plan");
    expect(r.next).toBeNull();
    // by slug, and a body-less lookup
    const slug = (await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [id])).rows[0]!.slug;
    expect((await call("getSlides", { slug }, w.agent, w.ws) as Slides).note.id).toBe(id);
  });

  it("pages a long deck: offset, limit and next at the boundary", async () => {
    const w = await world("slidespage");
    const id = await w.note(Array.from({ length: 5 }, (_, i) => `## Page ${i + 1}\n\n- a\n- b`).join("\n\n---\n\n"));
    const first = await call("getSlides", { id, limit: 2 }, w.agent, w.ws) as Slides;
    expect(first.pages.map((p) => p.position)).toEqual([1, 2]);
    expect(first.next).toBe(2);
    const last = await call("getSlides", { id, offset: 4, limit: 2 }, w.agent, w.ws) as Slides;
    expect(last.pages.map((p) => p.position)).toEqual([5]);
    expect(last.next).toBeNull();
    const exact = await call("getSlides", { id, offset: 3, limit: 2 }, w.agent, w.ws) as Slides;
    expect(exact.next).toBeNull();
  });

  it("answers null for a note that is missing, deleted, or in a space the caller cannot read", async () => {
    const w = await world("slidesnull");
    const hidden = (await createNote({ actor: w.owner, workspaceId: w.ws, title: "secret", markdown: DECK, spaceId: w.private_, event: { uiContext: "test" } })).node.id as string;
    expect(await call("getSlides", { id: hidden }, w.agent, w.ws)).toBeNull();
    expect(await call("getSlides", { id: "11111111-1111-4111-8111-111111111111" }, w.agent, w.ws)).toBeNull();
    const gone = await w.note(DECK);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [gone]);
    expect(await call("getSlides", { id: gone }, w.agent, w.ws)).toBeNull();
    expect(await rejection(call("getSlides", {}, w.agent, w.ws))).toBeTruthy(); // needs id or slug
  });

  it("setSlideLayout stores the choice in slides_data, getSlides shows it, and null hands the page back", async () => {
    const w = await world("setlayout");
    const id = await w.note(DECK);
    const pages = (await call("getSlides", { id }, w.agent, w.ws) as Slides).pages;
    const key = pages[1]!.key;
    const set = await call("setSlideLayout", { id, key, layout: "bullets" }, w.agent, w.ws) as { changed: boolean; page: { layout: string; layoutChosen: boolean } };
    expect(set).toMatchObject({ changed: true, page: { layout: "bullets", layoutChosen: true } });
    expect((await slidesData(id)).layouts[key]).toBe("bullets");
    const again = await call("getSlides", { id }, w.agent, w.ws) as Slides;
    expect(again.pages[1]).toMatchObject({ layout: "bullets", autoLayout: "three", layoutChosen: true });
    // the same choice again writes nothing
    expect(await call("setSlideLayout", { id, key, layout: "bullets" }, w.agent, w.ws)).toMatchObject({ changed: false });
    // theme on its own
    await call("setSlideLayout", { id, theme: "dark" }, w.agent, w.ws);
    expect((await slidesData(id)).theme).toBe("dark");
    // taking everything back removes the attribute, as the app's own writer does
    await call("setSlideLayout", { id, key, layout: null }, w.agent, w.ws);
    await call("setSlideLayout", { id, theme: "site" }, w.agent, w.ws);
    expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = 'slides_data'`, [id])).rows).toHaveLength(0);
    const events = (await q<{ event_type: string }>(`SELECT event_type FROM domain_events WHERE target_id = $1 AND event_type LIKE 'ATTRIBUTE_%' ORDER BY id`, [id])).rows.map((e) => e.event_type);
    expect(events).toContain("ATTRIBUTE_SET");
    expect(events).toContain("ATTRIBUTE_DELETED");
  });

  it("a layout chosen under a page's old key still counts, and setSlideLayout moves it to the page's key or clears it", async () => {
    const w = await world("legacykey");
    // Page 2 has no heading: its key reads its first block (`p:item one`); before keys read the text in writing order it was `p:some paragraph`.
    const id = await w.note("## A\n\nx\n\n---\n\n- item one\n\nsome paragraph\n");
    const pages = (await call("getSlides", { id }, w.agent, w.ws) as Slides).pages;
    expect(pages[1]!.key).toBe("p:item one");
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, 'slides_data', $3, 'text')`,
      [w.ws, id, JSON.stringify({ v: 1, theme: "site", layouts: { "p:some paragraph": "quote" } })]);
    const seen = (await call("getSlides", { id }, w.agent, w.ws) as Slides).pages[1]!;
    expect(seen).toMatchObject({ layout: "quote", layoutChosen: true });
    // changing another page keeps that choice, now under the page's own key
    await call("setSlideLayout", { id, key: pages[0]!.key, layout: "text" }, w.agent, w.ws);
    expect((await slidesData(id)).layouts).toEqual({ "p:item one": "quote", "h:a": "text" });
    // taking the choice back clears it (not left under the old key)
    await call("setSlideLayout", { id, key: pages[1]!.key, layout: null }, w.agent, w.ws);
    expect((await slidesData(id)).layouts).toEqual({ "h:a": "text" });
  });

  it("refuses an unknown layout, a key the note has no page for, and half an argument; a dry run writes nothing", async () => {
    const w = await world("setbad");
    const id = await w.note(DECK);
    const key = (await call("getSlides", { id }, w.agent, w.ws) as Slides).pages[0]!.key;
    expect(await rejection(call("setSlideLayout", { id, key, layout: "carousel" }, w.agent, w.ws))).toBeTruthy();
    const noKey = await rejection(call("setSlideLayout", { id, key: "h:nope", layout: "text" }, w.agent, w.ws)) as { status?: number; message: string };
    expect(noKey.status).toBe(422);
    expect(noKey.message).toContain("getSlides");
    expect(await rejection(call("setSlideLayout", { id, key }, w.agent, w.ws))).toBeTruthy();
    expect(await rejection(call("setSlideLayout", { id }, w.agent, w.ws))).toBeTruthy();
    const dry = await call("setSlideLayout", { id, key, layout: "text" }, w.agent, w.ws, true) as { changed: boolean };
    expect(dry.changed).toBe(true);
    expect((await slidesData(id)).layouts).toEqual({});
  });

  it("a reader (view only) and an unreadable or deleted note cannot be changed", async () => {
    const w = await world("setperm");
    const id = await w.note(DECK);
    const key = (await call("getSlides", { id }, w.agent, w.ws) as Slides).pages[0]!.key;
    expect(await call("getSlides", { id }, w.reader, w.ws)).not.toBeNull(); // may read
    expect(await rejection(call("setSlideLayout", { id, key, layout: "text" }, w.reader, w.ws))).toBeInstanceOf(AuthorityError);
    const hidden = (await createNote({ actor: w.owner, workspaceId: w.ws, title: "secret", markdown: DECK, spaceId: w.private_, event: { uiContext: "test" } })).node.id as string;
    expect((await rejection(call("setSlideLayout", { id: hidden, key, layout: "text" }, w.agent, w.ws)) as { status?: number }).status).toBe(404);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id]);
    expect((await rejection(call("setSlideLayout", { id, key, layout: "text" }, w.agent, w.ws)) as { status?: number }).status).toBe(404);
    expect((await slidesData(id)).layouts).toEqual({});
  });

  it("an agent set to suggest is refused like every other direct write (same rule as applyTag), also on a dry run", async () => {
    const w = await world("setsuggest");
    const id = await w.note(DECK);
    const key = (await call("getSlides", { id }, w.agent, w.ws) as Slides).pages[0]!.key;
    await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
    const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
    const real = await rejection(call("setSlideLayout", { id, key, layout: "text" }, agent, w.ws));
    expect(real).toBeInstanceOf(ScopeError);
    expect((real as ScopeError).code).toBe("suggest_only");
    expect(await rejection(call("setSlideLayout", { id, key, layout: "text" }, agent, w.ws, true))).toBeInstanceOf(ScopeError);
    // (applyTag, removeTag and every other direct write meet the same assertWriteModeAllows in mutate())
    expect((await slidesData(id)).layouts).toEqual({});
    // reading still works
    expect(await call("getSlides", { id }, agent, w.ws)).not.toBeNull();
  });

  it("is still offered where the workspace's stored module list lacks slides (always on)", async () => {
    const w = await world("slidesoff");
    await setModulesOn(w.ws, ["ai"]);
    const id = await w.note(DECK);
    expect(await call("getSlides", { id }, w.agent, w.ws)).not.toBeNull();
  });
});

describe.skipIf(!isTestDb)("listSuggestions", () => {
  it("shows each place with its state and times; filters; hides unreadable notes", async () => {
    const w = await world("sugg");
    const base = "one\n\ntwo\n\nthree\n";
    const id = await w.note(base);
    const filed = await createSuggestions(w.ws, {
      actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId: id,
      baseMarkdown: base, proposedMarkdown: "ONE\n\ntwo\n\nTHREE\n",
    });
    expect(filed.itemCount).toBe(2);
    const listed = (await suggestionsForNode(w.ws, id, { actor: w.owner }))!.suggestions[0]!;
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: listed.id, itemIds: [listed.items[0]!.id] });
    await rejectSuggestionItems(w.ws, { actor: w.owner, suggestionId: listed.id, itemIds: [listed.items[1]!.id] });

    type R = { suggestions: Array<{ from: { isYou: boolean }; createdAt: string; places: Array<{ place: number; status: string; original: string; suggested: string | null; decidedAt: string | null }> }>; next: number | null };
    const r = await call("listSuggestions", { id }, w.agent, w.ws) as R;
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.from.isYou).toBe(true);
    expect(r.suggestions[0]!.places.map((p) => [p.place, p.status, p.original.trim(), p.suggested?.trim()])).toEqual([[1, "accepted", "one", "ONE"], [2, "rejected", "three", "THREE"]]);
    expect(r.suggestions[0]!.places.every((p) => p.decidedAt !== null)).toBe(true);
    expect(new Date(r.suggestions[0]!.createdAt).getTime()).not.toBeNaN();
    expect(r.next).toBeNull();
    const rejectedOnly = await call("listSuggestions", { id, status: "rejected" }, w.agent, w.ws) as R;
    expect(rejectedOnly.suggestions[0]!.places).toHaveLength(1);
    expect((await call("listSuggestions", { id, status: "pending" }, w.agent, w.ws) as R).suggestions).toHaveLength(0);
    // someone else's: by default another agent does not see it; only mine=false lists every agent's
    expect((await call("listSuggestions", { id }, w.reader, w.ws) as R).suggestions).toHaveLength(0);
    const seen = await call("listSuggestions", { id, mine: false }, w.reader, w.ws) as R;
    expect(seen.suggestions[0]!.from.isYou).toBe(false);
    // paging: a second suggestion, then one per page
    await createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId: id, baseMarkdown: base, proposedMarkdown: "one\n\nTWO\n\nthree\n" });
    const p1 = await call("listSuggestions", { id, limit: 1 }, w.agent, w.ws) as R;
    expect(p1.suggestions).toHaveLength(1);
    expect(p1.next).toBe(1);
    const p2 = await call("listSuggestions", { id, limit: 1, offset: 1 }, w.agent, w.ws) as R;
    expect(p2.suggestions).toHaveLength(1);
    expect(p2.next).toBeNull();
    // no access, no such note, deleted note
    const hidden = (await createNote({ actor: w.owner, workspaceId: w.ws, title: "secret", markdown: base, spaceId: w.private_, event: { uiContext: "test" } })).node.id as string;
    expect(await call("listSuggestions", { id: hidden }, w.agent, w.ws)).toBeNull();
    expect(await call("listSuggestions", { id: "11111111-1111-4111-8111-111111111111" }, w.agent, w.ws)).toBeNull();
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id]);
    expect(await call("listSuggestions", { id }, w.agent, w.ws)).toBeNull();
  });
});

describe.skipIf(!isTestDb)("listSuggestions text budget", () => {
  it("one call carries a bounded amount of text; the left-out places are counted and can be read from nextPlace on", async () => {
    const w = await world("sugbudget");
    const para = (c: string, n: number) => (c.repeat(n)).slice(0, n);
    const base = Array.from({ length: 30 }, (_, i) => para(String.fromCharCode(97 + (i % 26)), 3000) + ` b${i}`).join("\n\n") + "\n";
    const proposed = Array.from({ length: 30 }, (_, i) => para(String.fromCharCode(65 + (i % 26)), 3000) + ` p${i}`).join("\n\n") + "\n";
    const id = await w.note(base);
    const filed = await createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId: id, baseMarkdown: base, proposedMarkdown: proposed });
    expect(filed.itemCount).toBe(30);
    type P = { place: number; original: string; suggested: string | null };
    type R = { next: number | null; suggestions: Array<{ id: string; places: P[]; placesOmitted?: number; nextPlace?: number }> };
    const first = await call("listSuggestions", { id }, w.agent, w.ws) as R;
    const s1 = first.suggestions[0]!;
    const chars = (ps: P[]) => ps.reduce((n, p) => n + p.original.length + (p.suggested?.length ?? 0), 0);
    expect(chars(s1.places)).toBeLessThanOrEqual(40_000 + 4);
    expect(s1.placesOmitted).toBeGreaterThan(0);
    expect(s1.places.length + s1.placesOmitted!).toBe(30);
    expect(s1.nextPlace).toBe(s1.places.length + 1);
    // read the rest, call by call, until every place has been seen once
    const seen = new Set(s1.places.map((p) => p.place));
    let from = s1.nextPlace;
    for (let guard = 0; from !== undefined && guard < 10; guard++) {
      const more = (await call("listSuggestions", { id, suggestionId: s1.id, fromPlace: from }, w.agent, w.ws) as R).suggestions[0]!;
      expect(more.places[0]!.place).toBe(from);
      for (const p of more.places) { expect(seen.has(p.place)).toBe(false); seen.add(p.place); }
      from = more.nextPlace;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});

describe.skipIf(!isTestDb)("listChildren / listSpaces", () => {
  const mk = async (w: Awaited<ReturnType<typeof world>>, title: string, parentId?: string, spaceId?: string) =>
    (await createNote({ actor: w.owner, workspaceId: w.ws, title, markdown: "", ...(parentId ? { parentId } : { spaceId: spaceId ?? w.space }), event: { uiContext: "test" } })).node.id as string;
  type Kids = { nodes: Array<{ id: string; title: string; hasChildren: boolean; hidden: boolean; children?: Array<{ title: string }>; moreChildren?: boolean }>; next: number | null; parent: unknown };

  it("lists in sidebar order (pinned first), nests by depth, pages, and skips deleted notes", async () => {
    const w = await world("kids");
    const root = await mk(w, "Root");
    const a = await mk(w, "A", root);
    const b = await mk(w, "B", root);
    const c = await mk(w, "C", root);
    await mk(w, "A1", a);
    const gone = await mk(w, "Gone", root);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [gone]);
    await seedQ(`UPDATE content_nodes SET order_key = 'a3' WHERE id = $1`, [a]);
    await seedQ(`UPDATE content_nodes SET order_key = 'a1' WHERE id = $1`, [b]);
    await seedQ(`UPDATE content_nodes SET order_key = 'a2' WHERE id = $1`, [c]);
    const r = await call("listChildren", { id: root }, w.agent, w.ws) as Kids;
    expect(r.nodes.map((n) => n.title)).toEqual(["B", "C", "A"]);
    expect(r.nodes.find((n) => n.title === "A")!.hasChildren).toBe(true);
    expect(r.nodes.find((n) => n.title === "B")!.hasChildren).toBe(false);
    // pinned notes lead their siblings, as in the sidebar
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, '_pinned', 'true', 'text')`, [w.ws, a]);
    expect((await call("listChildren", { id: root }, w.agent, w.ws) as Kids).nodes[0]!.title).toBe("A");
    const deep = await call("listChildren", { id: root, depth: 2 }, w.agent, w.ws) as Kids;
    expect(deep.nodes[0]!.children!.map((n) => n.title)).toEqual(["A1"]);
    // paging: boundary at exactly the limit, and one short of it
    const p1 = await call("listChildren", { id: root, limit: 2 }, w.agent, w.ws) as Kids;
    expect(p1.nodes).toHaveLength(2);
    expect(p1.next).toBe(2);
    const p2 = await call("listChildren", { id: root, limit: 2, offset: 2 }, w.agent, w.ws) as Kids;
    expect(p2.nodes).toHaveLength(1);
    expect(p2.next).toBeNull();
    expect((await call("listChildren", { id: root, limit: 3 }, w.agent, w.ws) as Kids).next).toBeNull();
  });

  /** `count` children of `parentId` in its space, inserted in one statement (a test fixture, not a product path). */
  const bulkChildren = (w: Awaited<ReturnType<typeof world>>, parentId: string, count: number, label: string) => seedQ(
    `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown, parent_id, space_id)
     SELECT $1, 'content', 'manual', $3 || g, $3 || g || '-' || substr(md5($2::text), 1, 6), '', $2::uuid, p.space_id
       FROM generate_series(1, $4::int) g, content_nodes p WHERE p.id = $2::uuid`, [w.ws, parentId, label, count]);

  it("depth 2: a parent with more than a whole call's rows of children does not starve the parent after it", async () => {
    const w = await world("fair");
    const root = await mk(w, "Root2");
    // The big parent sorts first by id: a shared LIMIT over both parents would be used up by it alone.
    const big = (await createNote({ actor: w.owner, workspaceId: w.ws, title: "Big", markdown: "", parentId: root, id: "00000000-0000-4000-8000-000000000001", event: { uiContext: "test" } })).node.id as string;
    const small = (await createNote({ actor: w.owner, workspaceId: w.ws, title: "Small", markdown: "", parentId: root, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", event: { uiContext: "test" } })).node.id as string;
    await seedQ(`UPDATE content_nodes SET order_key = CASE id WHEN $1::uuid THEN 'a1' ELSE 'a2' END WHERE id IN ($1::uuid, $2::uuid)`, [big, small]);
    await bulkChildren(w, big, 250, "big-");
    await mk(w, "only-child", small);
    const r = await call("listChildren", { id: root, depth: 2 }, w.agent, w.ws) as Kids;
    const bigNode = r.nodes.find((n) => n.title === "Big")!;
    const smallNode = r.nodes.find((n) => n.title === "Small")!;
    expect(bigNode.children).toHaveLength(20);
    expect(bigNode.moreChildren).toBe(true);
    expect(smallNode.children!.map((n) => n.title)).toEqual(["only-child"]);
    expect(smallNode.moreChildren).toBeUndefined();
  });

  it("depth 2: when the call's node budget runs out, parents left unlisted say moreChildren instead of showing nothing", async () => {
    const w = await world("budget");
    const root = await mk(w, "Root3");
    const parents: string[] = [];
    for (let i = 0; i < 12; i++) parents.push(await mk(w, `P${String(i).padStart(2, "0")}`, root));
    for (const [i, p] of parents.entries()) await seedQ(`UPDATE content_nodes SET order_key = $2 WHERE id = $1`, [p, `a${i}`]);
    for (const p of parents) await bulkChildren(w, p, 20, "c-");
    const r = await call("listChildren", { id: root, depth: 2 }, w.agent, w.ws) as Kids;
    const listed = r.nodes.reduce((n, p) => n + 1 + (p.children?.length ?? 0), 0);
    expect(listed).toBeLessThanOrEqual(200);
    const starved = r.nodes.filter((p) => p.hasChildren && (p.children?.length ?? 0) < 20);
    expect(starved.length).toBeGreaterThan(0); // 12 + 12*20 > 200: the budget did run out
    for (const p of starved) expect(p.moreChildren, `${p.title} shows fewer children than it has`).toBe(true);
    for (const p of r.nodes.filter((p) => (p.children?.length ?? 0) === 20)) expect(p.moreChildren).toBeUndefined();
  });

  it("lists a space's top level; refuses (null) a space or note the caller cannot read; both or neither argument is an error", async () => {
    const w = await world("tops");
    const top = await mk(w, "Top note");
    const priv = await mk(w, "Private top", undefined, w.private_);
    const r = await call("listChildren", { spaceId: w.space }, w.agent, w.ws) as Kids;
    expect(r.nodes.map((n) => n.id)).toContain(top);
    expect(r.nodes.map((n) => n.id)).not.toContain(priv);
    expect(await call("listChildren", { spaceId: w.private_ }, w.agent, w.ws)).toBeNull();
    expect(await call("listChildren", { id: priv }, w.agent, w.ws)).toBeNull();
    expect(await call("listChildren", { id: "11111111-1111-4111-8111-111111111111" }, w.agent, w.ws)).toBeNull();
    expect(await rejection(call("listChildren", {}, w.agent, w.ws))).toBeTruthy();
    expect(await rejection(call("listChildren", { id: top, spaceId: w.space }, w.agent, w.ws))).toBeTruthy();
    const deleted = await mk(w, "Deleted parent");
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [deleted]);
    expect(await call("listChildren", { id: deleted }, w.agent, w.ws)).toBeNull();
    // a view-only reader may list what it can read
    expect(await call("listChildren", { spaceId: w.space }, w.reader, w.ws)).not.toBeNull();
  });

  it("listSpaces gives the spaces the caller reaches with its permission, and no others", async () => {
    const w = await world("spaces");
    type S = { spaces: Array<{ id: string; name: string; permission: string }> };
    const mine = await call("listSpaces", {}, w.agent, w.ws) as S;
    expect(mine.spaces.find((s) => s.id === w.space)).toMatchObject({ permission: "edit" });
    expect(mine.spaces.map((s) => s.id)).not.toContain(w.private_);
    const reader = await call("listSpaces", {}, w.reader, w.ws) as S;
    expect(reader.spaces.find((s) => s.id === w.space)).toMatchObject({ permission: "view" });
    expect(Object.keys(mine.spaces[0]!).sort()).toEqual(["id", "kind", "name", "permission"]);
    await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
    const suggester = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
    expect((await call("listSpaces", {}, suggester, w.ws) as S).spaces.find((s) => s.id === w.space)).toMatchObject({ permission: "suggest" });
    // a space that does not let external AI in is not listed for a token
    await q(`UPDATE spaces SET capabilities = jsonb_set(capabilities, '{external_ai}', 'false') WHERE id = $1`, [w.space]);
    expect((await call("listSpaces", {}, w.agent, w.ws) as S).spaces.map((s) => s.id)).not.toContain(w.space);
  });
});
