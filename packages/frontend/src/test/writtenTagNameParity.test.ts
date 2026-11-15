// A tag name written in a note names one tag (D63): the client's offline lookup
// (lib/data/tagPaths.ts findTagIdByPath) follows the server's rule
// (tagHierarchy.tagIdForWrittenName) — from the root, exact title first, else
// the one case-insensitive match. The same fixture is checked on the backend
// (packages/backend/src/test/writtenTagNameParity.integration.test.ts).

import { describe, it, expect } from "vitest";
import fixture from "./fixtures/writtenTagNameParity.json";
import { findTagIdByPath } from "../lib/data/tagPaths";

const id = (key: string) => `id-${key}`;

describe("a written tag name resolves as the server resolves it", () => {
  for (const c of fixture.cases) {
    const tags = c.tags.map((t) => ({ id: id(t.key), name: t.name, parent_id: "parent" in t && t.parent ? id(t.parent) : null }));
    for (const [written, expected] of Object.entries(c.resolve)) {
      it(`${c.title}: "${written}"`, () => {
        expect(findTagIdByPath(tags, written)).toBe(expected === null ? null : id(expected));
      });
    }
  }
});
