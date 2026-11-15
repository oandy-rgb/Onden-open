// Round trip 5: Markdown parse → serialize → parse keeps the block structure.
//
// No database. Onden has no serializer for a whole Markdown body (a body is
// stored as the text it was typed as); the serializers it has are the ones a
// note passes through on its way out and back:
//   - frontmatter (entryFor / writeFrontmatter ↔ readFrontmatter / entryValue),
//   - the multi-value codec (encodeValues ↔ attributeValues),
//   - the export file (exportedNoteFile: frontmatter + body),
//   - the block-tag editor (addBlockTag).
// Each is run over generated bodies (helpers/roundTripArb.ts: prose, headings,
// lists, tasks, code, math, images, wikilinks, `^ref` anchors, embeds) and the
// block structure (parseLegacyBlocks, legacyBlockAnchors, listLinkTargets; 正文裡的 `^ref` 在新模型只是文字，這裡仍用舊讀法確認往返不動它) is compared
// before and after. Replay a failing body with ROUNDTRIP_SEED=<seed>.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addBlockTag, attributeValues, blockTagSlot, encodeValues, entryFor, entryValue, legacyBlockAnchors, listLinkTargets, parseBlocks, parseLegacyBlocks,
  readFrontmatter, writeFrontmatter, type ParsedBlock,
} from "@onden/markdown";
import { exportedNoteFile } from "../../services/exportZip.js";
import { blockSpec, roundTripRuns, titleText, word, type NoteSpec, type WorldSpec } from "../helpers/roundTripArb.js";
import { renderBody } from "../helpers/roundTripRender.js";

const runs = () => ({ ...roundTripRuns({ maxRuns: 100 }), endOnFailure: false });

/** What a block is, apart from where it sits (offsets shift under frontmatter). */
const shape = (blocks: ParsedBlock[]) => blocks.map((b) => [b.kind, b.ref, b.tags, b.tagSource, b.label, b.parent, b.checkbox?.checked ?? null]);
const anchors = (markdown: string) => legacyBlockAnchors(markdown).map((a) => a.id);
const targets = (markdown: string) => listLinkTargets(markdown).map((t) => (t.kind === "heading" ? [t.kind, t.text, t.depth] : [t.kind, t.text, t.ref]));

/** A body of generated blocks, linking among `count` notes titled n0…. */
const bodies = fc.integer({ min: 1, max: 5 }).chain((count) =>
  fc.array(blockSpec(count, { blockTags: true }), { minLength: 1, maxLength: 10 }).map((blocks) => {
    const notes: NoteSpec[] = Array.from({ length: count }, (_, i) => ({ title: `n${i}`, parent: null, blocks: i === 0 ? blocks : [], tags: [], attrs: [], trashed: false, media: false }));
    const spec: WorldSpec = { tags: [], notes, canvas: null };
    return renderBody(notes[0]!, 0, spec, notes.map((_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`), undefined);
  }));

// Text a value can be: any characters, including the ones YAML treats as syntax.
const SYNTAX = ["", " ", "#", ":", "'", '"', "-", "---", "[", "]", "{", "}", ",", "|", ">", "&", "*", "!", "%", "@", "`", "\\", "\n", "\t", "true", "null", "yes", "~"];
const anyValue = fc.array(fc.oneof(word, fc.constantFrom(...SYNTAX)), { maxLength: 6 }).map((parts) => parts.join(fc.sample(fc.constantFrom("", " "), 1)[0]!));
const key = fc.constantFrom("status", "author", "作者", "進度", "source_note", "topics", "rating", "x-1", "_y");

describe("frontmatter: write → read", () => {
  it("a scalar or list value is read back as written, and writing it again is the same text", () => {
    fc.assert(fc.property(fc.array(fc.tuple(key, fc.oneof(anyValue, fc.array(anyValue, { minLength: 1, maxLength: 4 }))), { maxLength: 5 }), (pairs) => {
      const unique = [...new Map(pairs).entries()];
      const written = writeFrontmatter(unique.map(([k, v]) => entryFor(k, v)));
      const read = readFrontmatter(written);
      if (unique.length === 0) { expect(written).toBe(""); return; }
      expect(read, written).not.toBeNull();
      expect(read!.entries.map((e) => [e.key, entryValue(e)]), written).toEqual(unique.map(([k, v]) => [k, Array.isArray(v) ? v : v]));
      expect(writeFrontmatter(read!.entries)).toBe(written);
    }), runs());
  });

  it("a body after the frontmatter comes back whole, whatever it starts with", () => {
    fc.assert(fc.property(bodies, fc.constantFrom("", "---\n", "---\nkey: v\n---\n", "\n", "# h\n"), (body, prefix) => {
      const text = prefix + body;
      const written = writeFrontmatter([entryFor("title", "T"), entryFor("tags", ["a", "b/c"])]) + text;
      expect(readFrontmatter(written)!.body).toBe(text);
    }), runs());
  });
});

describe("the multi-value codec", () => {
  it("a list encodes to one stored string that reads back as the list", () => {
    fc.assert(fc.property(fc.array(anyValue.filter((v) => v !== ""), { maxLength: 5 }), (values) => {
      const stored = encodeValues(values);
      expect(attributeValues(stored)).toEqual(values);
      expect(encodeValues(attributeValues(stored))).toBe(stored);
    }), runs());
  });
});

describe("the export file", () => {
  it("keeps the body, and the body's blocks, anchors and link targets, under the frontmatter it adds", () => {
    fc.assert(fc.property(bodies, titleText, fc.array(fc.constantFrom("a", "b/c", "學校/演算法"), { maxLength: 3 }), (body, title, tags) => {
      const file = exportedNoteFile({ id: "00000000-0000-4000-8000-000000000000", slug: "s", title, markdown: body, updated_at: "2026-01-01T00:00:00Z", tags }, [], body);
      const back = readFrontmatter(file)!.body.replace(/^(\r?\n)+/, "");
      // The export ends a body with one newline; otherwise the text is the same.
      expect(back).toBe(body.endsWith("\n") ? body : `${body}\n`);
      expect(shape(parseLegacyBlocks(back))).toEqual(shape(parseLegacyBlocks(body)));
      expect(anchors(back)).toEqual(anchors(body));
      expect(targets(back)).toEqual(targets(body));
      // And with the frontmatter on, the blocks are still found.
      expect(shape(parseLegacyBlocks(file))).toEqual(shape(parseLegacyBlocks(body)));
    }), runs());
  });
});

describe("the block-tag editor", () => {
  it("adding a tag to the block at a caret gives that block the tag", () => {
    fc.assert(fc.property(bodies, fc.constantFrom("idea", "題目", "q-1"), fc.nat(), (body, tag, caret) => {
      const offset = caret % (body.length + 1);
      const slot = blockTagSlot(body, offset);
      fc.pre(slot !== null && slot.tags.length === 0 && slot.braces === null);
      const tagged = addBlockTag(body, offset, tag)!;
      expect(parseBlocks(tagged).some((b) => b.tags.includes(tag)), "the block carries the tag").toBe(true);
    }), runs());
  });
});
