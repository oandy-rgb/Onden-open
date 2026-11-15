// 「不發布」 through the Markdown export → import: whatever the author's own `publish` field says (in the stored text,
// as an attribute, in both places with different values, or not at all), a note kept off the site is read back as
// kept off, and the author's own field is not changed to make room for the mark.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { check } from "../helpers/propsConfig.js";
import { fieldValue, readFrontmatter } from "@onden/markdown";
import { exportedNoteFile } from "../../services/exportZip.js";
import { importedNoteContent } from "../../modules/importers/markdown/note.js";

const NODE = { id: "11111111-1111-4111-8111-111111111111", slug: "n", title: "N", markdown: "", updated_at: "2026-01-01T00:00:00.000Z", tags: [] };
const OFF = { key: "_published", value: "false", source: "ui" };
const value = fc.constantFrom("false", "FALSE", "true", "draft", "later", "yes");
const optional = fc.option(value, { nil: undefined });

describe("a note kept off the site survives export → import", () => {
  it("whatever the author's own publish field is, in the text and as an attribute", () => {
    check(fc.property(fc.boolean(), optional, optional, (keptOff, inText, asAttribute) => {
      const stored = inText === undefined ? "Body\n" : `---\npublish: ${inText}\n---\n\nBody\n`;
      const attributes = [
        ...(keptOff ? [OFF] : []),
        ...(asAttribute === undefined ? [] : [{ key: "publish", value: asAttribute, source: "ui" }]),
      ];
      const back = importedNoteContent(exportedNoteFile(NODE, attributes, stored));
      if (keptOff) expect(back.keptOff, "kept off").toBe(true);
      // The attribute is the current value of the field, the text the stale one (exportedNoteFile).
      const own = asAttribute ?? inText;
      if (own !== undefined) expect(fieldValue(readFrontmatter(back.markdown)?.entries ?? [], "publish"), "the author's field").toBe(own);
    }));
  });

  it("the case that lost it: the text says false, the attribute was edited to true, the note is kept off", () => {
    const file = exportedNoteFile(NODE, [OFF, { key: "publish", value: "true", source: "ui" }], "---\npublish: false\n---\n\nBody\n");
    expect(file).toMatch(/^publish: "?true"?$/m);
    expect(file).toMatch(/^onden_publish: false$/m);
    expect(importedNoteContent(file).keptOff).toBe(true);
  });
});
