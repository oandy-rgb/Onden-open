// @vitest-environment jsdom
// `[[A#^id]]` / `![[A#^id]]` when A no longer holds the block: the embed shows
// the note that does, and a click opens it (lib/blockHome; the server picks).
// A's own block, and every case with no answer, behave as before.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ContentNode } from "../lib/api";

const { reads } = await import("../lib/data");
const { resetDrawingCache } = await import("../lib/embedSources");
const { blockLinkTarget, resetBlockHomeCache } = await import("../lib/blockHome");
const { replaceAllAnchors } = await import("../lib/blockAnchorStore");
const { anchored, holdAnchored } = await import("./helpers/anchoredText");
const { default: MarkdownRenderer } = await import("../components/MarkdownRenderer");

const note = (over: Partial<ContentNode> & { id: string; title: string }) =>
  ({ slug: over.title.toLowerCase(), markdown: "", node_type: "content", ...over }) as unknown as ContentNode;
// The paragraph's id is its anchor in the store (the text carries none): Beta holds anchor m1, Alpha lost it.
const alpha = note({ id: "a1", title: "Alpha", markdown: "The paragraph moved away.\n" });
const beta = note({ id: "b1", title: "Beta", markdown: anchored("Intro\n\nThe moved idea. ^m1\n").markdown });
const home = (n: ContentNode) => ({ id: n.id, title: n.title, slug: n.slug, space_id: null });

beforeEach(() => { holdAnchored("b1", "Intro\n\nThe moved idea. ^m1\n"); });
afterEach(() => { resetDrawingCache(); resetBlockHomeCache(); replaceAllAnchors([]); vi.restoreAllMocks(); });

describe("block embed fallback", () => {
  it("shows the block from the note that holds it, with that note on the source line", async () => {
    const ask = vi.spyOn(reads.notes, "blockHome").mockResolvedValue(home(beta));
    const onNavigate = vi.fn();
    const { container, findByText } = render(
      <MarkdownRenderer nodes={[alpha, beta]} onNavigate={onNavigate}>{"![[Alpha#^m1]]"}</MarkdownRenderer>,
    );
    await waitFor(() => expect(container.querySelector(".md-transclusion-body")?.textContent).toContain("The moved idea."));
    expect(ask).toHaveBeenCalledWith("a1", "m1");
    fireEvent.click(await findByText("— Beta"));
    expect(onNavigate).toHaveBeenCalledWith("beta", "b1", "m1");
  });

  it("does not ask while the named note holds the block", async () => {
    const ask = vi.spyOn(reads.notes, "blockHome").mockResolvedValue(home(beta));
    holdAnchored("a1", "Still here ^m1");
    const holds = note({ id: "a1", title: "Alpha", markdown: "Still here" });
    const { container } = render(<MarkdownRenderer nodes={[holds, beta]} onNavigate={() => {}}>{"![[Alpha#^m1]]"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-transclusion-body")?.textContent).toContain("Still here"));
    expect(ask).not.toHaveBeenCalled();
  });

  it("says the paragraph was deleted when the server has no home (none, several, offline, or not permitted)", async () => {
    vi.spyOn(reads.notes, "blockHome").mockResolvedValue(null);
    const { container } = render(<MarkdownRenderer nodes={[alpha, beta]} onNavigate={() => {}}>{"![[Alpha#^m1]]"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-embed-notice")?.textContent).toBe("This paragraph was deleted"));
  });

  it("reads a slim home note through the data layer", async () => {
    const far = holdAnchored("b1", "Far away text ^m1");
    const slim = note({ id: "b1", title: "Beta", markdown: "", body_len: 30 } as never);
    vi.spyOn(reads.notes, "blockHome").mockResolvedValue(home(beta));
    const read = vi.spyOn(reads.notes, "full").mockResolvedValue({ ...slim, markdown: far } as ContentNode);
    const { container } = render(<MarkdownRenderer nodes={[alpha, slim]} onNavigate={() => {}}>{"![[Alpha#^m1]]"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-transclusion-body")?.textContent).toContain("Far away text"));
    expect(read).toHaveBeenCalledWith("b1");
  });
});

describe("blockLinkTarget (what a click on [[Note#^id]] opens)", () => {
  it("opens the named note while it holds the block, without asking the server", async () => {
    const ask = vi.spyOn(reads.notes, "blockHome").mockResolvedValue(home(beta));
    expect(await blockLinkTarget(beta, "m1", [alpha, beta])).toBe(beta);
    expect(ask).not.toHaveBeenCalled();
  });

  it("opens the note that holds it when the named one lost it", async () => {
    vi.spyOn(reads.notes, "blockHome").mockResolvedValue(home(beta));
    expect(await blockLinkTarget(alpha, "m1", [alpha, beta])).toBe(beta);
  });

  it("uses the server's row for a note the app does not hold", async () => {
    vi.spyOn(reads.notes, "blockHome").mockResolvedValue({ id: "z9", title: "Far", slug: "far", space_id: null });
    expect(await blockLinkTarget(alpha, "m1", [alpha])).toMatchObject({ id: "z9", title: "Far" });
  });

  it("keeps the named note when nothing answers, and when its text cannot be read", async () => {
    const ask = vi.spyOn(reads.notes, "blockHome").mockResolvedValue(null);
    expect(await blockLinkTarget(alpha, "m1", [alpha, beta])).toBe(alpha);
    const slim = note({ id: "s1", title: "Slim", markdown: "", body_len: 9 } as never);
    vi.spyOn(reads.notes, "body").mockResolvedValue(null);
    ask.mockClear();
    expect(await blockLinkTarget(slim, "m1", [slim])).toBe(slim);
    expect(ask).not.toHaveBeenCalled();
  });
});
