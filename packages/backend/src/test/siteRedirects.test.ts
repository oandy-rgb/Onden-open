// GAP-240: a renamed note's (or tag's) old site address keeps reaching it.
// The pure halves of publishing/siteRedirects.ts; the snapshot read and the
// served answer end to end are in siteRedirects.integration.test.ts.
import { describe, expect, it } from "vitest";
import { nextRedirects, servedRedirects, REDIRECTS_MAX, type RedirectEntry } from "../modules/website/publishing/siteRedirects.js";
import { withoutNodes } from "../services/purgedContent.js";

const e = (slug: string, id: string): RedirectEntry => ({ slug, id });

describe("nextRedirects", () => {
  it("a rename leaves the old address behind, pointing at the note", () => {
    expect(nextRedirects([], [e("plan", "n1")], [e("roadmap", "n1")])).toEqual([e("plan", "n1")]);
  });
  it("an address a page has now is the page's, not a redirect", () => {
    expect(nextRedirects([], [e("plan", "n1"), e("notes", "n2")], [e("plan", "n1"), e("notes", "n2")])).toEqual([]);
  });
  it("renaming back takes the old address back from the redirects", () => {
    const once = nextRedirects([], [e("plan", "n1")], [e("roadmap", "n1")]);
    expect(nextRedirects(once, [e("roadmap", "n1")], [e("plan", "n1")])).toEqual([e("roadmap", "n1")]);
  });
  it("two notes swapping names keep no redirect: both addresses are pages", () => {
    expect(nextRedirects([], [e("a", "n1"), e("b", "n2")], [e("b", "n1"), e("a", "n2")])).toEqual([]);
  });
  it("a new note taking an old address wins over the redirect", () => {
    const moved = nextRedirects([], [e("plan", "n1")], [e("roadmap", "n1")]);
    expect(nextRedirects(moved, [e("roadmap", "n1")], [e("roadmap", "n1"), e("plan", "n2")])).toEqual([]);
  });
  it("carries redirects on through later publishes, and a note renamed twice keeps both old addresses", () => {
    const first = nextRedirects([], [e("a", "n1")], [e("b", "n1")]);
    const second = nextRedirects(first, [e("b", "n1")], [e("c", "n1")]);
    expect(second).toEqual([e("a", "n1"), e("b", "n1")]);
  });
  it("names no note that is not on the new site: taken down, its old addresses go (publishRedaction)", () => {
    const moved = nextRedirects([], [e("plan", "n1")], [e("roadmap", "n1"), e("other", "n2")]);
    expect(nextRedirects(moved, [e("roadmap", "n1"), e("other", "n2")], [e("other", "n2")])).toEqual([]);
  });
  it("an address served again by another note moves to the newest end", () => {
    const old = [e("x", "n9"), e("a", "n1")];
    expect(nextRedirects(old, [e("x", "n2")], [e("y", "n1"), e("z", "n2"), e("w", "n9")])).toEqual([e("a", "n1"), e("x", "n2")]);
  });
  it("keeps at most `max`, dropping the oldest", () => {
    const many = Array.from({ length: 5 }, (_, i) => e(`s${i}`, `n${i}`));
    const live = Array.from({ length: 5 }, (_, i) => e(`now${i}`, `n${i}`));
    expect(nextRedirects(many, [], live, 3).map((r) => r.slug)).toEqual(["s2", "s3", "s4"]);
    expect(REDIRECTS_MAX).toBe(1000);
  });
  it("keeps integer-like slugs in their order", () => {
    const live = [e("p1", "n1"), e("p2", "n2"), e("p3", "n3")];
    expect(nextRedirects([e("2024", "n1"), e("10", "n2")], [e("3", "n3")], live).map((r) => r.slug)).toEqual(["2024", "10", "3"]);
  });
});

describe("servedRedirects", () => {
  const stored = { notes: [e("plan", "n1"), e("gone", "n2"), e("taken", "n3")], tags: [e("books", "t1"), e("old-tag", "t2")] };
  const notes = [{ id: "n1", slug: "roadmap" }, { id: "n3", slug: "elsewhere" }, { id: "n4", slug: "taken" }];
  const tagPages = { t1: { slug: "reading", name: "Reading" } };

  it("sends an old address to the page's current one, for notes and tag pages", () => {
    expect(servedRedirects(stored, notes, tagPages)).toEqual([
      { from: "/site/plan/", to: "/site/roadmap/" },
      { from: "/site/tag/books/", to: "/site/tag/reading/" },
    ]);
  });
  it("names nothing for a note or tag no longer served (taken down: a 404, not its new address)", () => {
    const out = servedRedirects(stored, notes, tagPages);
    expect(out.some((r) => r.from.includes("gone") || r.from.includes("old-tag"))).toBe(false);
  });
  it("leaves an old address that a served page uses now to that page", () => {
    expect(servedRedirects(stored, notes, tagPages).some((r) => r.from === "/site/taken/")).toBe(false);
  });
  it("is empty for a snapshot without redirects or with malformed ones", () => {
    expect(servedRedirects(undefined, notes, tagPages)).toEqual([]);
    expect(servedRedirects({ notes: [["plan", "n1"], { slug: 3, id: "n1" }, null], tags: "x" }, notes, null)).toEqual([]);
  });
});

describe("purging a note (withoutNodes)", () => {
  it("drops its old addresses from the stored snapshot", () => {
    const payload = { nodes: [{ id: "n1", slug: "roadmap" }], redirects: { notes: [e("secret-plan", "gone1"), e("plan", "n1")], tags: [] } };
    const next = withoutNodes(payload, new Set(["gone1"])) as typeof payload;
    expect(next.redirects.notes).toEqual([e("plan", "n1")]);
    expect(JSON.stringify(next)).not.toContain("secret-plan");
  });
});
