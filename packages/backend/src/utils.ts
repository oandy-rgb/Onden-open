import { createHash } from "node:crypto";
import { z } from "zod";
import { attributeLines, encodeValues, entryValue, normalizeText, readFrontmatter, wikilinkBodies, wikilinkNames, wikilinkTarget, NODE_MARKDOWN_MAX, NODE_TITLE_MAX } from "@onden/markdown";
import { noNul } from "@onden/contract";

/** Note size caps (@onden/markdown noteLimits.ts, shared with the app), here
 *  for REST (@onden/contract DraftNode) and the agent tools; createNote and applyBodyChange
 *  enforce the same caps (services/noteSize.ts). */
export { NODE_MARKDOWN_MAX, NODE_TITLE_MAX };

/** SHA-256 of text (UTF-8) or bytes as lower-case hex: the one digest for
 *  token hashes, content addresses and change fingerprints. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The name-based (version 5) UUID of `name` in `namespace`: the same id on
 *  every device and the server for one name (day note ids, @onden/markdown
 *  DAY_NOTE_NAMESPACE; the app computes the same in lib/uuid.ts nameBasedUUID). */
export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.concat([Buffer.from(namespace.replace(/-/g, ""), "hex"), Buffer.from(name, "utf8")]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `text` as a LIKE/ILIKE pattern that matches it literally: `\`, `%` and `_`
 *  lose their wildcard meaning (Postgres' default escape character is `\`).
 *  Not for media URLs, which are matched with strpos (services/mediaAccess.ts). */
export function escapeLike(text: string | number): string {
  // A view filter's value comes from jsonb and may be a number.
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Pattern for "contains `text`". */
export const containsPattern = (text: string | number): string => `%${escapeLike(text)}%`;

/** What a new note may carry besides its own fields, the same for REST POST
 *  /api/nodes and the agent createNode tool (services/noteCreate.ts applies
 *  them in the creating transaction). */
export const newNoteExtrasSchema = z.object({
  tag_ids: z.array(z.string().uuid()).max(20).optional(),
  // A top-level note's space; without it the note goes to the creator's
  // personal space (docs/architecture/spaces.md). Ignored under a parent,
  // whose space the child shares.
  space_id: z.string().uuid().optional(),
  attributes: z.array(z.object({
    key: noNul(z.string().min(1).max(200)),
    value: z.union([noNul(z.string()), z.number(), z.boolean(), z.null()]),
    value_type: z.enum(["text", "number", "date", "bool", "node_ref"]).optional(),
    is_inheritable: z.boolean().optional(),
  })).max(50).optional(),
});


export function extractWikilinks(markdown: string): string[] {
  return Array.from(
    new Set(
      wikilinkBodies(markdown)
        // `[[name.excalidraw]]` also names `name` (@onden/markdown wikilinkNames).
        .flatMap((body) => wikilinkNames(wikilinkTarget(body)))
        .filter(Boolean) as string[],
    ),
  );
}

// Parse inline attributes from a node's markdown body.
//
// Three syntaxes recognized (all additive — last-write-wins on key conflict,
// matching Onden's pre-existing #key=value semantics tested in
// markdownExtract.test.ts):
//
//   1. Onden's own `#key=value`            — compact hashtag-style (legacy)
//   2. Obsidian / Dataview `key:: value`   — standalone-line form
//   3. Obsidian / Dataview `[key:: value]` — inline bracketed form
//
// References (verified during W2 retroactive cross-check, see
// memory/project_w2_phase_implementation_crosscheck):
//
//   - Obsidian/Dataview convention dictates `key:: value` with space after `::`.
//     We mirror their space-required form.
//
//   - logseq-master/src/test/frontend/util/text_test.cljs uses `key::value`
//     (no space). Onden intentionally diverges to space-required form to avoid
//     matching `::` inside identifier syntax like `foo::bar` namespaces.
//
//   - Trilium-main/apps/client/src/services/attribute_parser.ts (230 lines)
//     uses a proper LEXER with:
//       * Quote handling (`"..."`, `'...'`, backtick)
//       * Escape sequences (`\` followed by next char is literal)
//       * Inheritability marker `#tag(inheritable)`
//       * Operator symbol recognition (=, *, >, <, !)
//     Onden's regex parser is intentionally simpler for MVP — it DOES NOT:
//       * Strip surrounding quotes from values (`key:: "v"` → value is `"v"`)
//       * Handle nested brackets in bracketed form (`[k:: [nested]]` stops at
//         the first `]`)
//       * Support escape sequences (`\::` doesn't escape the operator)
//     These are MVP-acceptable gaps; revisit if real workflows hit them.
//
// The lines themselves are read by @onden/markdown attributeLines — the same
// rule the renderer uses to hide the standalone form, fences (``` and ~~~)
// skipped — so a `key:: value` inside a code block never leaks into the index
// and a line is indexed exactly when the reader no longer sees it (D34).
export function extractAttributes(markdown: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const found = attributeLines(markdown);
  // All three forms write into the same map, form by form (#key=value, then
  // `key:: value`, then `[key:: value]`), each in document order. Last write
  // wins, consistent with the user's likely mental model ("the latest value I
  // typed sticks") and the original #key=value form's documented behaviour.
  for (const form of ["hashtag", "line", "bracket"] as const) {
    for (const a of found) if (a.form === form) attrs[a.key] = a.value;
  }
  return attrs;
}

// W2 P5: extract YAML frontmatter as a key→value map.
//
// Returns `null` if the markdown has no frontmatter fence at the top.
// Returns `{}` if the fence is present but empty.
//
// References (verified during pre-implementation grep):
//
//   - Onden's existing `parseFrontmatter` in modules/importers/routes.ts handles title
//     + tags (3 list forms) via regex. This function generalises the same
//     pattern to ALL keys so they all flow through the attribute substrate.
//
//   - joplin-dev/packages/lib/services/interop/InteropService_Importer_Md_frontmatter.ts
//     uses `js-yaml` (full YAML, ~70KB). Onden deliberately stays with the
//     tiny line-oriented subset — same trade-off documented in
//     OndenQueryBlock.tsx (the inline-query YAML parser).
//
//   - Obsidian's frontmatter handling (memory/project_obsidian_markdown_block_pattern):
//     YAML at top of file, between `---` fences. Coexists with inline
//     `key:: value` — frontmatter is file-level, inline is block-level.
//
// Supported syntax (covers ~95% of typical user-written frontmatter):
//
//   key: value                  → simple scalar
//   key: "quoted value"         → strip surrounding quotes
//   key: 'single-quoted'        → strip surrounding quotes
//   key: [a, b, c]              → inline array (JSON-encoded into single value)
//   key:                        → block-list array (JSON-encoded)
//     - a                         '
//     - b                         '
//
// NOT supported (MVP gaps, documented):
//
//   - Nested keys (`a.b: value` or `a:\n  b: c`)
//   - Multiline scalars (`>` / `|` block style)
//   - Anchors / references (`&anchor`, `*ref`)
//   - Inline maps (`{k: v}`)
export function extractFrontmatterAttributes(markdown: string): Record<string, string> | null {
  // The same codec export and import use (@onden/markdown frontmatter.ts), so a
  // value written there reads back unchanged here (quotes unescaped, lists as
  // lists). Shapes it doesn't model — nested maps, multi-line strings, lists
  // of maps — yield no attribute and stay in the text untouched.
  const fm = readFrontmatter(markdown);
  if (!fm) return null;
  const out: Record<string, string> = {};
  for (const entry of fm.entries) {
    const value = entryValue(entry);
    if (value === undefined || !entry.key) continue;
    const key = normalizeText(entry.key); // keys in NFC, as attributeLines reads them (D58)
    if (Array.isArray(value)) { if (value.length) out[key] = encodeValues(value); } // the one list codec (D117)
    else out[key] = value;
  }
  return out;
}
