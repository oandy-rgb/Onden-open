import { describe, expect, it } from "vitest";
import fixture from "./fixtures/wikilinkTargets.json";
import { servedLinkTarget } from "./sitePath.js";

// The site's side of the link-target fixture (fixtures/wikilinkTargets.json).
// The app (frontend wikilinkTargetsParity.test.ts) and the SQL edge rule
// (backend wikilinkTargets.integration.test.ts) read the same file, so "which
// note does [[x]] name" is checked against one list of answers.
// A served site is one space's live pages, so the cases that need the
// workspace-wide rules (`site: false`) are not run here.

describe("servedLinkTarget (shared fixture)", () => {
  for (const c of fixture.cases.filter((x) => (x as { site?: boolean }).site !== false)) {
    it(c.name, () => {
      const from = fixture.notes.find((n) => n.id === c.from)!;
      const served = fixture.notes
        .filter((n) => n.space === from.space && !(n as { deleted?: boolean }).deleted && (n as { type?: string }).type !== "class_tag")
        .map((n) => ({ id: n.id, title: n.title, slug: n.slug, aliases: (n as { aliases?: string[] }).aliases }));
      expect(servedLinkTarget(c.link, served, c.from)?.id ?? null).toBe(c.opens);
    });
  }
});
