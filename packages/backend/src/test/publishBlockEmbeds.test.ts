// `![[Note#^id]]` / `![[Note#Heading]]` on the published site. The app shows
// these as the source's text, but the site never transcludes: the server pass
// (modules/website/publishing/drawingEmbeds.ts serveDrawingEmbeds) turns them into a
// plain link when the source is on the site and the placeholder when it is
// not, so no sentence of an unpublished note can reach a published page. Pure:
// no database.

import { describe, expect, it } from "vitest";
import { serveDrawingEmbeds } from "../modules/website/publishing/drawingEmbeds.js";
import { redactPayloadNodes } from "../modules/website/publishing/redaction.js";

type N = { id: string; title: string; slug: string; markdown: string; embeds?: string[] };

function publishAndServe(nodes: N[]): N[] {
  redactPayloadNodes(nodes); // publish step: embeds of unpublished notes go inert
  serveDrawingEmbeds(nodes); // serve step: what is left becomes links
  return nodes;
}

describe("published block / section embeds", () => {
  const home = (): N => ({
    id: "h", title: "Home", slug: "home",
    markdown: "![[Shared#^k]]\n\n![[Shared#Goals]]\n\n![[Secret#^s]]\n\n![[Secret#Plans|my plans]]\n\ninline ![[Shared#^k]] too",
  });
  const shared = (): N => ({ id: "s1", title: "Shared", slug: "shared", markdown: "Public idea.\n\n## Goals\n\nPublic goal" });

  it("a block / section of a note on the site is a link, never its text", () => {
    const [h] = publishAndServe([home(), shared()]);
    expect(h!.markdown).toBe("[[Shared#^k]]\n\n[[Shared#Goals]]\n\n(private)\n\nmy plans\n\ninline [[Shared#^k]] too");
    expect(h!.markdown).not.toContain("Public idea");
    expect(h!.markdown).not.toContain("![[");
  });

  it("keeps the bodies of the embeds that became links, so a page can tell them from plain links", () => {
    const [h, sh] = publishAndServe([
      { ...home(), markdown: `${home().markdown}\n\nplain [[Shared]]` },
      shared(),
    ]);
    // Only embeds of notes on the site; the unpublished ones left no trace, here either.
    expect(h!).toHaveProperty("embeds", ["Shared#^k", "Shared#Goals"]);
    expect(JSON.stringify(h)).not.toContain("Secret");
    expect(sh!).not.toHaveProperty("embeds");
  });

  it("an embed of an unpublished note's block leaves no trace of its text or title", () => {
    // `Secret` is not among the published nodes, so it is not in the payload.
    const [h] = publishAndServe([home(), shared()]);
    for (const leak of ["Hidden", "Secret", "^s", "Plans"]) expect(h!.markdown).not.toContain(leak);
  });

  it("a takedown after the publish still turns the link into the placeholder", () => {
    const frozen = [home(), shared()];
    redactPayloadNodes(frozen);
    // Shared is taken down: the served nodes no longer include it.
    const served = frozen.filter((n) => n.id !== "s1");
    serveDrawingEmbeds(served);
    expect(served[0]!.markdown).not.toContain("Shared");
    expect(served[0]!.markdown).not.toContain("Public");
  });
});
