// Block-anchor parity (audit D59), the exports' side. A paragraph's identity is an anchor row (block_anchors), not a
// `^id` in the text, and the published site / exports (md2html) carry no anchor rows: so a block carries no
// `data-block-id`, and a `^id` typed into a note is text like any other. The shared fixture
// packages/markdown/src/fixtures/blockAnchors.json is written in the OLD format (the migration's input); it is
// converted with stripLegacyIds first, the same way the migration does.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripLegacyIds } from "@onden/markdown";
import { md2html } from "../modules/website/publishing/htmlUtils.js";

const fixtureDir = new URL("../../../markdown/src/fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("blockAnchors.json", fixtureDir), "utf8")) as {
  markdown: string; anchors: Array<{ id: string; kind: string; element: string }>; inCode: string[];
};
const legacyNote = readFileSync(new URL(fixture.markdown, fixtureDir), "utf8");

describe("md2html and the anchor model agree (shared fixture)", () => {
  it("a converted note renders with no data-block-id and no ^id outside code", () => {
    // `#topic ^hb` (Obsidian's hashtag block) is the one line the migration leaves alone; drop the hashtag as the markdown package's test does.
    const converted = stripLegacyIds(legacyNote.replace("Hashtag line #topic ^hb", "Hashtag line ^hb").replace(" ^li2", "").replace(" ^qp", ""));
    if ("refused" in converted) throw new Error(converted.refused);
    const html = md2html(converted.markdown);
    expect(html).not.toMatch(/data-block-id/);
    for (const { id } of fixture.anchors) expect(html, id).not.toContain(`^${id}`);
    for (const id of fixture.inCode) expect(html, id).toContain(`^${id}`);
  });

  it("a `^id` typed into the text is shown as the words it is (it names nothing any more)", () => {
    const html = md2html("A paragraph ^p1\n");
    expect(html).toContain("^p1");
    expect(html).not.toMatch(/data-block-id/);
  });
});
