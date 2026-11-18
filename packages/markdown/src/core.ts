// Onden's one Markdown pipeline (W38c, docs/architecture/site-render-model.md).
// The app (react-markdown in MarkdownRenderer) and the server-side exports
// (unified → HTML in the backend) parse and transform a note with the SAME
// plugin list and the SAME sanitize schema, so a note renders the same in the
// editor preview, on the published site and in a downloaded export.
//
// Two profiles, differing only in inline HTML:
//   - "app": inline HTML in a note is parsed (rehype-raw) and then sanitized
//     — the editor, cards, review, collections, RSS reader;
//   - "published": only the few tags Onden's own editor writes are parsed —
//     <u>, <mark>, <audio>, <video>, <source> (PUBLISHED_HTML_TAGS); any other
//     inline HTML stays visible as text — the public site, the Studio and the
//     exports (the offline copy of the site). Decided by the user 2026-10-14
//     so existing notes keep their underlines, highlights and players.
// Everything else — GFM, callouts, math (remark-math + KaTeX), code
// highlighting, ^block-id / key:: value hiding, frontmatter — is on in both.
//
// What stays with each renderer: how elements are drawn (React components
// for wikilinks, mermaid, embeds and task checkboxes; HTML post-processing
// on the server) and where a [[wikilink]] points (`wikilinkHref`).
//
// KaTeX and the code grammars are handed in (`MarkdownEnhancers`), so this
// entry imports neither: the server's `ondenMarkdown` (@onden/markdown/full)
// registers all of them, the app loads what a note needs (lazy.ts).
//
// Usage (react-markdown):
//   const md = ondenMarkdownCore({ profile: "app", wikilinkHref }, enhancers);
//   <ReactMarkdown remarkPlugins={md.remarkPlugins} rehypePlugins={md.rehypePlugins}
//     remarkRehypeOptions={md.remarkRehypeOptions}>{md.prepare(text)}</ReactMarkdown>
// Usage (unified):
//   unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
//     .use(md.rehypePlugins).use(rehypeStringify)

import type { Pluggable, PluggableList } from "unified";
import type { VFile } from "vfile";
import type { Root as HastRoot } from "hast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkWikiLink from "remark-wiki-link";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { visit } from "unist-util-visit";
import { remarkBlockId } from "./remarkBlockId.js";
import { remarkHeadingIds } from "./headingAnchors.js";
import { remarkInlineAttrs } from "./remarkInlineAttrs.js";
import { remarkSoftBreaks } from "./remarkSoftBreaks.js";
import { remarkCallouts } from "./callouts.js";
import { WIKILINK_SYNTAX } from "./parsers.js";
import { remarkCjkEmphasis } from "./cjkEmphasis.js";
import { stripFrontmatter } from "./frontmatter.js";
export { parseSkillMd, skillNoteMarkdown, skillMdMarkdown, mentionsBundledFiles, SkillMdError, SKILL_OUTPUTS, SKILL_AI_MODES, readSkillSettings, withSkillSettings } from "./skillFile.js";
export type { ParsedSkillMd, SkillNoteInput, SkillSettings, SkillAiMode } from "./skillFile.js";
import { sanitizeSchema, DOM_ID_PREFIX } from "./sanitizeSchema.js";
import { rehypeHighlightCode, type HighlightScope } from "./highlight.js";
import { normalizeText } from "./word.js";
import { BLOCK_ID_PATTERN } from "./blockId.js";
import { remarkEmbeds } from "./embedsRemark.js";

export { sanitizeSchema, DOM_ID_PREFIX } from "./sanitizeSchema.js";
export { COMMON_GRAMMAR_NAMES, grammarNames, hasAllGrammars, registerMoreGrammars, grammarFor, withEmbedded, rehypeHighlightCode, type GrammarName, type HighlightScope, type Lowlight } from "./highlight.js";
export { markdownNeeds, type MarkdownNeeds } from "./needs.js";
export { isUuid, UUID_SOURCE } from "./uuid.js";
export { articlePrefix, withinPrefix } from "./articlePrefix.js";
export { isHexColor, normalizeHexColor } from "./color.js";
export {
  TASKS_MODULE_ID, TASK_ATTR, DAY_NOTE_NAMESPACE, DERIVED_ID_NAMESPACE, derivedIdName, TASKS_NOTE_TITLE, dayNoteIdName, PUBLISHED_EDGE_TYPES, REWIND_MAX_NOTES, TAG_PAGE_ROWS_MAX,
  PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, TAG_NAME_MAX, TASK_STATUSES, RESERVED_TAGS, type TaskStatus, type ReservedTagKey, cleanCustomDomain, isCustomDomainHost, isSystemAttr, PUBLISHED_ATTR_KEY, KEPT_OFF_BY_PARENT_ATTR_KEY, newNoteSiteDefault, isEditorStorageAttr, EDITOR_STORAGE_ATTR_KEYS, INK_DATA_ATTR, BOARD_INK_ATTR, NOTE_INK_ATTR, HANDWRITING_LAYOUT, INK_PAGE_ATTRS, isInkPageAttr, INK_KINDS, INK_KIND_ATTR, isInkKind, type InkKind, VIEW_NAME_MAX, SPACE_NAME_MAX, TASK_TITLE_MAX, EXTERNAL_CALENDAR_NAME_MAX, AI_NAME_MAX, INK_PRESET_NAME_MAX, BUILT_IN_FIELDS, FILTER_OP_NAMES, type FilterOpName,
  CLIENT_PROTOCOL_HEADER, SERVER_PROTOCOL_HEADER, CLIENT_PROTOCOL, SYNC_PATH_PREFIXES, isSyncPath, protocolMismatch, DEVICE_ID_HEADER, CLIENT_NOW_HEADER, BOARD_CARDS_PER_REQUEST_MAX, BOARD_SECTIONS_PER_REQUEST_MAX,
} from "./sharedContract.js";
export { REMIND_CATCH_UP_MS, reminderMoment, reminderKey, reminderAgoMs, reminderStatusOpen, dueReminderMoment, type ReminderNow, type ReminderFields, type ReminderMoment } from "./taskReminder.js";
export { appendedBody } from "./appendBlock.js";
// A note as slides (the 「簡報」 view, and the server's getSlides tool): one cut, one layout rule for both sides.
export { parseDeck, type SlideDeck, type Slide, type DeckSource } from "./slideDeck.js";
export { analyzeSlide, plainWords, itemText, slideBlockText, listItems, emLength, isFigure, type SlideBlock, type SlideBlockKind } from "./slideAnalyze.js";
export { pagesOf, partsOf, autoLayoutOf, layoutOfPage, chosenLayout, layoutSource, layoutsByPageKey, isLayoutId, LAYOUT_IDS, MAX_SUBTITLE, NUMBER_LEAD, TIME_LEAD, type SlidePage, type SlidePageParts, type LayoutId, type AnchorSpan } from "./slidePages.js";
export { SLIDE_LAYOUTS, slideLayoutSpec, itemsOf, splitStat, splitStep, sidesOf, alternativeLayout, growLevel, hasTable, TOO_MUCH_HINT, TABLE_TOO_MUCH_HINT, type SlideLayoutSpec, type GrowLevel } from "./slideLayouts.js";
export { SLIDES_DATA_ATTR, SLIDES_THEMES, parseSlidesData, serializeSlidesData, withPageLayout, withSlidesTheme, type SlidesData, type SlidesTheme } from "./slidesData.js";
export { CLOCK_24H_SOURCE, isClockTime, parseLineTime, formatLineTime, withLineTime, type LineTime } from "./taskTime.js";
export { taskBoxEdit } from "./taskBox.js";
export { codeHighlighter } from "./codeTokens.js";
export { loadEnhancers, loadAllEnhancers, enhancersFor, type LoadedEnhancers } from "./lazy.js";
export {
  storageType, normalize, governingField, fieldViolation, inferFieldType, freeFormType, inferFromValue, isCalendarDate, isCalendarDay, toCalendarDate, calendarDayOf,
  serializeValue, parseValue, NUMBER_PATTERN, isStoredNumber, storedNumber, ATTRIBUTE_VALUE_TYPES, ATTRIBUTE_FIELD_TYPES,
  storedValueType, compareAttribute, compareAttributeOrder, attributeValues, encodeValues, isListValue,
  type AttributeValueType, type AttributeFieldType, type AttributeField, type NormalizedAttributeValue,
  type AttributeComparison,
} from "./attributeValue.js";
export { compareChildren, sortChildren, compareTitles, compareText, type OrderedChild } from "./childOrder.js";
export { addDays, daysBetween, addMonths, canonicalZoneName, weekdayOf, stepMonth, buildMonthGrid, type MonthCell } from "./calendar.js";
export { parseDateText, type ParsedDate, type DateParseOptions } from "./dateParse.js";
export { dayNoteDate } from "./dayNote.js";
export { mergeEditRuns, sortDayItems, isDayItemPast, layoutDayItems, EDIT_RUN_GAP_MINUTES, TIMELINE_KINDS, onTimeline, POINT_ITEM_MINUTES } from "./dayItems.js";
export type { DayItem, DayItemKind, DayItemRef, DayEdit, DayWindow, PlacedDayItem, DayLens, DayLensBucket, DayLensNote } from "./dayItems.js";
export { dayBucket, taskBucket, taskHome, UPCOMING_DAYS, type TaskBucket, type TaskHome } from "./taskBucket.js";
export { parseRecur, isParsableRecur, isValidRecur, advanceDate, nextDueAfter, nextOccurrenceDate, type RecurRule, type RecurUnit, type RecurMode } from "./recur.js";
export { MEDIA_TAG_NAMES, mediaSanitizeAttributes } from "./mediaSanitize.js";
export { LINK_SCHEMES, IMAGE_SCHEMES, SAFE_DATA_MEDIA_SRC, SAFE_DATA_IMAGE_SRC, urlScheme, isHttpUrl, isSafeLinkHref, hasSafeLinkScheme, isSafeImageSrc } from "./urlSchemes.js";
import { SAFE_DATA_MEDIA_SRC } from "./urlSchemes.js";
export { EMBED_IFRAME_ATTRS, EMBED_IFRAME_ALLOW, EMBED_IFRAME_REFERRER_POLICY, EMBED_DEFAULT_TITLE, rehypeMediaSvgLinks } from "./embedFrame.js";
export {
  YOUTUBE_THUMB_HOST, LITE_EMBED_CLASS, LITE_EMBED_LINK_CLASS, LITE_EMBED_THUMB_CLASS, LITE_EMBED_HOST_CLASS, LITE_EMBED_PLAY_CLASS,
  liteEmbedOf, liteEmbedHast, liteEmbedFrameHtml, type LiteEmbed,
} from "./liteEmbed.js";
export { AUDIO_SPEEDS, AUDIO_SPEED_CLASS, AUDIO_SPEED_ATTR, nextAudioSpeed, audioSpeedLabel, litePlaySrc } from "./mediaMarkup.js";
export { TRUSTED_EMBED_HOSTS, EMBED_IFRAME_SANDBOX, isAllowedEmbedSrc, classifyMedia, toEmbedUrl, type MediaKind } from "./mediaEmbed.js";
export { MEDIA_TYPES, MAX_REQUEST_BYTES, MAX_MEDIA_REQUEST_BYTES, DEFAULT_MAX_BACKUP_REQUEST_BYTES, capMegabytes, mediaExtension, mediaTypeOf, extensionsOf, isImageName, isSiteImageName, SITE_IMAGE_ACCEPT, acceptFor, type MediaFileKind, type MediaType } from "./mediaTypes.js";
export {
  stripFrontmatter, stripSettingsFrontmatter, parseFrontmatter, frontmatterLength, frontmatterEndLine, readFrontmatter, writeFrontmatter, entryValue, entryFor, fieldValue, fieldList, PUBLISH_OFF_KEY, PUBLISH_OFF_FALLBACK_KEY, keepsOffSite, publishOffEntry,
  type FrontmatterEntry, type FrontmatterValue,
} from "./frontmatter.js";
export { linkSlug, slugify } from "./slug.js";
export { cjkAttentionSides } from "./cjkEmphasis.js";
export { graphemes, graphemeCount, cutToUnits, cutToBytes, cutToCodePoints, cutToGraphemes, ellipsize } from "./graphemes.js";
export { NODE_REF_PREFIX, nodeRefTarget, nodeRefId } from "./nodeRef.js";
export { NODE_TITLE_MAX, NODE_MARKDOWN_MAX, noteSizeProblem, clampNoteTitle, hasLoneSurrogate } from "./noteLimits.js";
import { LONE_SURROGATE } from "./noteLimits.js";
export { hashText, makePatch, applyPatch, isTextPatch, TextPatchError, type TextPatch, type TextHunk } from "./textPatch.js";
export { escapeHtml, decodeHtmlEntities } from "./html.js";
export { applyTemplateVars, type TemplateVars } from "./templateVars.js";
export { WORD_CHAR, WORD_CHARS, normalizeText } from "./word.js";
export { noteSummary, bodyAfterTitle, type NoteSummaryOptions } from "./summary.js";
export { plainInline, plainAroundSpan, checklistLine, stripLineMarker, lineMarkerLength, wikilinkLabel } from "./plainText.js";
export { fenceScanner, fencedLines, withoutFences, openingFenceInfo, fenceInfoWord, type FenceLine } from "./fences.js";
export {
  DIAGRAM_LAYOUT_VERSION, DIAGRAM_LIMITS, DIAGRAM_SHAPES, DIAGRAM_ARROWS, DIAGRAM_LINES, diagramKindOf, mermaidSources, validateDiagramLayout, diagramsBySource, isSafePath,
  type DiagramLayout, type DiagramNode, type DiagramEdge, type DiagramGroup, type DiagramShape, type DiagramArrow, type DiagramLine, type DiagramKind, type DiagramCheck, type PrecompiledDiagram,
} from "./diagramLayout.js";
export { diagramSvgTree, diagramHast, DIAGRAM_CSS, SVG_TAGS, SVG_ATTRS, type SvgNode } from "./diagramSvg.js";
export { readingMinutes, countWords } from "./readingTime.js";
export { firstImage } from "./firstImage.js";
export { handwritingPageMarkdown, handwritingPageNumber, withoutHandwritingPages } from "./handwritingPage.js";
export { plainText } from "./linkContext.js";
export { plainExcerpt } from "./graphemes.js";
export { linkPlaces, CONTEXT_LENGTH, type ContextPiece, type LinkPlace, type LinkPlaceOptions } from "./linkPlaces.js";
export { MEDIA_URL_PREFIX, isMediaId, mediaUrl, mediaRefs, rewriteMediaRefs, bundleMedia, mediaSrc, type MediaSrcOptions } from "./mediaRefs.js";
export {
  scanWikilinks, soleWikilink, wikilinkBodies, replaceWikilinks, splitWikilink, hasLinkPath, wikilinkTarget, wikilinkNames, linkNamesNote, linkNameKey,
  TAG_NAME_CHAR, HASHTAG_RE, type WikilinkMatch,
} from "./text.js";
export { snippetAround, snippetPlainText, queryTerms, type Snippet, type SnippetRange, type SnippetOptions } from "./snippet.js";
export { sitePathFor, servedLinkTarget, aliasLinksBySlug, type ServedPage } from "./sitePath.js";
export { drawnWikilinks } from "./wikilinkSpans.js";
export { parseGfmTree, parseExportTree } from "./gfmTree.js";
export { attributeLines, standaloneAttributeLines, type AttributeLine, type AttributeForm } from "./attributeLines.js";
export { ATTRIBUTE_KEY, ATTRIBUTE_KEY_RULE, CHILD_KEY_PREFIX, isAttributeKey, isSettableAttributeKey } from "./attributeKey.js";
export { parseSearchQuery, type ParsedSearchQuery } from "./searchQuery.js";
export { remarkBlockId } from "./remarkBlockId.js";
export {
  parseEmbed, blankInkRegionSyntax, embedMatches, embedLine, embedLabel, embedBodyOfSrc, EMBED_SRC_PREFIX,
  type EmbedKind, type EmbedRef, type EmbedMatch,
} from "./embeds.js";
export { INK_REGION_MIN, clampInkRegion, formatInkRegion, parseInkRegion, type InkRegion } from "./inkRegion.js";
export { remarkInlineAttrs } from "./remarkInlineAttrs.js";
export { remarkSoftBreaks } from "./remarkSoftBreaks.js";
export { remarkCallouts, CALLOUT_TYPES, calloutType, parseCalloutMarker, stripCalloutMarker, type CalloutType } from "./callouts.js";
export { fieldNameClashes, newFieldNameClashes, type FieldClash, type FieldClashRow } from "./fieldClashes.js";
export {
  parseBlocks, parseLegacyBlocks, anchoredBlocks, blockSpans, legacyOrphanIds, legacyIdsIn, blocksParsable, mayHaveBlocks, legacyBlockAnchors, BLOCK_PARSE_MAX,
  blockTagSlot, blockTagSlotsIn, addBlockTag, splitTaggedParagraph, splitAnchorSpan, repairSplitBlockMarker,
  type ParsedBlock, type BlockKind, type BlockAnchor, type BlockTagSlot, type Span, type AnchorAt,
} from "./blocks.js";
export { stripLegacyIds, legacyIdShift, hasLegacyIds, writeLegacyIds, type WrittenLegacyIds, type LegacyAnchor, type LegacyIdConversion, type LegacyIdRefusal } from "./legacyBlockIds.js";
export { blockCardSides, blockNeighbours, CLOZE_GAP, type BlockCardSides, type BlockNeighbours } from "./blockCard.js";
export { listLinkTargets, LINK_TARGET_LABEL_MAX, type LinkTarget } from "./linkTargets.js";
export { headingAnchors, headingAnchorLines, headingFragment, anchorHref, remarkHeadingIds, type HeadingAnchor } from "./headingAnchors.js";
export { topBlocks, type TopBlock, type TopBlockKind } from "./slideBlocks.js";
export { noteHasBlock } from "./blockRef.js";
export {
  splitBlockLink, blockExcerpt, linkPathReadings, blockLinkText, blockLinkSource, bindingKey, blockLinkWords, blockExcerptOf, matchParts, readBlockLink, blockLinkShown,
  BLOCK_LINK_EXCERPT_MAX, BLOCK_LINK_TEXT_MAX,
  type LinkPath, type PartMatch, type AnchorFacts, type LinkNote, type BlockLinkEnv, type PartRef, type BlockLinkRead,
} from "./blockLink.js";
export { exportPartLinks, partLinkTargets, partPlainText, PART_LINK_EXPORT_MODES, EXPORTED_PART_MAX, type PartLinkExportMode, type ExportedPart } from "./partLinkExport.js";
export { writePartLinks, restorePartLinks, oldPartLinkIds, oldPartLinkWords, type OldPartLink } from "./blockLinkRewrite.js";
export { blockCitations, type BlockCitation } from "./blockCitations.js";
export { servedPartLink } from "./servedPartLink.js";
export { chooseBlockHome, servedBlockTarget, servedBlockPage, type BlockHomeCandidate, type BlockServedPage } from "./blockHome.js";
export { extractBlock, extractSection, embedEditable, type EmbedEditable } from "./embedExtract.js";
export {
  planBlockMove, planSelectionMove, planBlockExpand, wholeNoteEmbedLines, rewriteLinks, noteNamer, retargetToChild, retargetToParent, qualifyLocalLinks,
  type BlockMove, type BlockMoveRefusal, type BlockExpandRefusal, type EmbedLine, type LinkAnchor, type LinkRead, type NoteNames,
} from "./blockChild.js";
export { BLOCK_ID, BLOCK_ID_CHARS, BLOCK_ID_MAX, BLOCK_ID_PATTERN, newBlockId, trailingBlockId } from "./blockId.js";
export {
  excerptBlock, excerptPlain, excerptContext, parseExcerpts, excerptBlockSpans, excerptsOfPage, sameExcerpt, expandExcerptEmbeds, sourceLine, blockquote, EXCERPT_CONTEXT_MAX,
  type Excerpt, type ExcerptSource,
} from "./excerpt.js";
export { findMentions, parseMention, isMentionHandle, AI_MENTION_ALIAS, MENTION_HANDLE_MAX, RESERVED_MENTION_HANDLES, type Mention, type MentionTarget, type MentionSkillRef } from "./mentions.js";
export {
  QUERY_BLOCK_LANGS, FROZEN_ROWS_MAX, isQueryBlockLang, queryBlockKey, queryBlocksIn, frozenQueryBlock, parseQuerySpec,
  type QueryBlockLang, type FrozenQueryRow, type FrozenQueryBlock, type ParsedQuery,
} from "./queryBlocks.js";
export { parseYaml, parseBaseSpec, type BaseSpec, type FilterNode, type ViewDef } from "./basesParser.js";
export {
  evalFilter, applyView, baseTagNames, baseTableColumns, isTitleColumn, type BaseEvalNode, type BaseEvalContext,
} from "./basesEval.js";

export type MarkdownProfile = "app" | "published";

/** A `[[target#^block|alias]]` / `[[target#Heading]]` link as the renderer
 *  resolves it: the note it names (empty for a same-note `[[#^id]]` or
 *  `[[#Heading]]`), and the block id or the heading it points into (at most
 *  one is set; headingFragment finds the heading's anchor). */
export type WikilinkTarget = { target: string; blockId: string | null; heading: string | null };

export type OndenMarkdownOptions = {
  profile: MarkdownProfile;
  /** Read `$…$` / `$$…$$` as math (default). Off for text not written in
   *  Onden — an RSS article's `$5 to $10` is prices, not a formula. */
  math?: boolean;
  /** Where a [[wikilink]] points. Omitted: `[[…]]` stays plain text.
   *  `file` is the document being processed, so a caller that renders many
   *  notes through one processor passes what the links need in `file.data`
   *  rather than in a variable the processor shares (backend md2html). */
  wikilinkHref?: (link: WikilinkTarget, file: VFile) => string;
  /** The words a `[[link]]` without an alias shows, given its body (`Note/part`, `Note#^id`); null: the usual
   *  words (the note's name; a `^id` link reads as its note). The one hook by which a part link reads
   *  「筆記 › 開頭」 — each renderer passes its own reading of it (blockLink.ts readBlockLink). */
  wikilinkLabel?: (body: string, file: VFile) => string | null;
  /** Read `![[…]]` as embeds: each becomes an image whose src is the
   *  `#embed:` sentinel (embeds.ts), for the renderer to draw. Off (default):
   *  it stays text — the published site gets its drawings from the server. */
  embeds?: boolean;
  /** Wording of the footnote section's (screen-reader) heading and the
   *  back-link's aria-label. Omitted: remark-rehype's English defaults. */
  footnoteLabels?: { heading: string; back: (referenceNumber: number) => string };
  /** The paragraph anchors of the note rendered (block_anchors): each block one starts gets `data-block-id`. A block's
   *  identity is not in its text, so without them no block carries an id. */
  blockAnchors?: ReadonlyArray<{ id: string; from: number; to: number }>;
};

export type OndenMarkdown = {
  /** Apply to the source before parsing (removes YAML frontmatter, which
   *  remark would otherwise read as a setext heading). */
  prepare: (markdown: string) => string;
  remarkPlugins: PluggableList;
  /** Pass to remark-rehype: inline HTML stays raw nodes for the profile's
   *  rehype plugins to parse or neutralise, and ids are left for the
   *  sanitizer to prefix once (see rehypeLinkPrefixedIds). */
  remarkRehypeOptions: { allowDangerousHtml: true; clobberPrefix: ""; footnoteLabel?: string; footnoteBackLabel?: (referenceIndex: number) => string };
  rehypePlugins: PluggableList;
};

/** What the pipeline colours and typesets with. Either may be absent (not
 *  loaded yet): code then stays plain and math shows its source. */
export type MarkdownEnhancers = {
  /** Highlight.js `common` grammars, auto-detect for untagged fences
   *  (highlight.ts). Absent: no code block is coloured. */
  highlight?: HighlightScope;
  /** rehype-katex, run with KATEX_OPTIONS. */
  katex?: Pluggable;
};

/** Bounded: `\\rule{500em}{500em}` or a macro bomb can't paint the page or
 *  hang the renderer. (trust stays off: no \\href / \\includegraphics.) */
export const KATEX_OPTIONS = { maxSize: 20, maxExpand: 1000 } as const;

// `Note#^id` (the id grammar: blockId.ts). Anchored, with a bounded id, so
// `.*` backs off once over the target: linear.
const BLOCK_REF = new RegExp(`^(.*)#\\^(${BLOCK_ID_PATTERN})$`);

export function ondenMarkdownCore(
  { profile, math = true, wikilinkHref, wikilinkLabel: labelOf, embeds = false, footnoteLabels, blockAnchors }: OndenMarkdownOptions,
  { highlight, katex }: MarkdownEnhancers = {},
): OndenMarkdown {
  // ^block-id and key:: value markers are hidden before any plugin reads them
  // as text; soft breaks run last so callout titles still see raw newlines.
  // Heading ids are read first, from the text as written (headingAnchors.ts).
  const remarkPlugins: PluggableList = [remarkHeadingIds, [remarkBlockId, { anchors: blockAnchors }], remarkInlineAttrs, remarkCjkEmphasis, remarkGfm, remarkCallouts];
  if (math) remarkPlugins.push(remarkMath);
  if (embeds) remarkPlugins.push(remarkEmbeds);
  if (wikilinkHref) {
    remarkPlugins.push([remarkWikiLink, WIKILINK_SYNTAX], [remarkWikilinkHrefs, wikilinkHref], [remarkBlockRefLabels, labelOf]);
  }
  remarkPlugins.push(remarkSoftBreaks);

  const rehypePlugins: PluggableList = [
    ...(profile === "app" ? [rehypeRaw] : [rehypeOnlyPublishedHtml, rehypeRaw]),
    // One schema for every surface: no <script>, event handlers or
    // javascript: URLs; media tags allowed, their iframe HOSTS gated by each
    // renderer (the schema can only express the scheme).
    [rehypeSanitize, sanitizeSchema],
    ...(profile === "app" ? [] : [rehypeOnlyMediaDataSrc]),
    rehypeLinkPrefixedIds,
    // After sanitize: their output is produced by trusted code, not the note.
    ...(highlight ? [[rehypeHighlightCode, highlight] as Pluggable] : []),
    ...(katex ? [[katex, KATEX_OPTIONS] as Pluggable] : []),
  ];

  return {
    prepare: stripFrontmatter,
    remarkPlugins,
    remarkRehypeOptions: {
      allowDangerousHtml: true,
      clobberPrefix: "",
      ...(footnoteLabels && { footnoteLabel: footnoteLabels.heading, footnoteBackLabel: (referenceIndex: number) => footnoteLabels.back(referenceIndex + 1) }),
    },
    rehypePlugins,
  };
}


/** What a link body points at. The target in NFC, as every link target is
 *  compared (word.ts, D58); a heading path `Note#A#B` names its last heading,
 *  as in Obsidian. */
function linkTarget(raw: string): WikilinkTarget {
  // A lone surrogate would make every href builder's encodeURIComponent throw.
  const name = raw.replace(LONE_SURROGATE, "\ufffd");
  const block = name.match(BLOCK_REF);
  if (block) return { target: normalizeText(block[1]!), blockId: block[2]!, heading: null };
  const hash = name.indexOf("#");
  if (hash === -1) return { target: normalizeText(name), blockId: null, heading: null };
  const heading = name.slice(name.lastIndexOf("#") + 1).trim();
  return { target: normalizeText(name.slice(0, hash).trim()), blockId: null, heading: heading ? normalizeText(heading) : null };
}

/** Points each parsed `[[link]]` where `href` says. A transform, not
 *  remark-wiki-link's pageResolver, which runs while parsing and has no
 *  document to hand `href`. */
function remarkWikilinkHrefs(href: (link: WikilinkTarget, file: VFile) => string) {
  type WikiLink = { type: "wikiLink"; value: string; data?: { permalink?: string; hProperties?: { href?: string } } };
  return (tree: import("mdast").Root, file: VFile) => {
    visit(tree, (node) => (node as { type: string }).type === "wikiLink", (node) => {
      const link = node as unknown as WikiLink;
      if (!link.data?.hProperties) return;
      link.data.permalink = href(linkTarget(link.value), file);
      link.data.hProperties.href = link.data.permalink;
    });
  };
}

/** `[[Note#^abc]]` reads "Note" (`[[#^abc]]`: "^abc") instead of its raw
 *  target, or what `labelOf` says (a part link: 「Note › start」); an explicit `|alias` is kept. */
function remarkBlockRefLabels(labelOf?: (body: string, file: VFile) => string | null) {
  type WikiLink = { type: "wikiLink"; value: string; data?: { alias?: string; hChildren?: Array<{ type: string; value?: string }> } };
  return (tree: import("mdast").Root, file: VFile) => {
    visit(tree, (node) => (node as { type: string }).type === "wikiLink", (node) => {
      const link = node as unknown as WikiLink;
      if (!link.data || link.data.alias !== link.value) return;
      const block = link.value.match(BLOCK_REF);
      const said = labelOf?.(link.value, file) ?? null;
      if (!block && said === null) return;
      const label = said ?? (block![1] || `^${block![2]}`);
      link.data.alias = label;
      link.data.hChildren = [{ type: "text", value: label }];
    });
  };
}

/** Tags the published profile parses (the ones Onden's editor and quick-create
 *  write); their attributes still go through the sanitize schema. */
export const PUBLISHED_HTML_TAGS = ["u", "mark", "audio", "video", "source"] as const;
// A raw HTML node made only of those tags (opening, closing or self-closing)
// and whitespace. `Hi <u>x</u>` reaches here as three nodes: `<u>`, text, `</u>`.
const ONLY_PUBLISHED_TAGS = new RegExp(
  `^(?:\\s*</?(?:${PUBLISHED_HTML_TAGS.join("|")})(?:\\s[^<>]*)?/?>)+\\s*$`, "i");

/** The published profile: inline HTML in a note is shown as the text the
 *  author typed, except the PUBLISHED_HTML_TAGS, left for rehype-raw. */
function rehypeOnlyPublishedHtml() {
  // `raw` is the node remark-rehype emits for inline HTML (allowDangerousHtml);
  // hast's own types don't list it.
  type Raw = { type: "raw"; value: string };
  type WithChildren = { children: Array<Raw | { type: "text"; value: string } | { type: string }> };
  return (tree: HastRoot) => {
    visit(tree, (node) => (node as { type: string }).type === "raw", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const { value } = node as unknown as Raw;
      if (ONLY_PUBLISHED_TAGS.test(value)) return;
      (parent as unknown as WithChildren).children.splice(index, 1, { type: "text", value });
    });
  };
}

/** The published profile: the schema lets `data:` through on src and poster
 *  (the scheme is all it can say), so a `data:` address whose type is not
 *  image, audio or video (`data:text/html,…`) is dropped here, as urlSchemes.ts
 *  promises for every published surface. */
function rehypeOnlyMediaDataSrc() {
  type El = { properties?: Record<string, unknown> };
  return (tree: HastRoot) => {
    visit(tree, "element", (node) => {
      const props = (node as El).properties;
      if (!props) return;
      for (const key of ["src", "poster"]) {
        const value = props[key];
        if (typeof value === "string" && /^\s*data:/i.test(value) && !SAFE_DATA_MEDIA_SRC.test(value.trim())) delete props[key];
      }
    });
  };
}

/** The sanitizer prefixes every id with `user-content-` (DOM_ID_PREFIX, so
 *  a note can't clobber the page's own DOM ids); in-note `#fragment` links —
 *  footnotes, their back-references, `[see](#目標)` to a heading — follow
 *  their target to its prefixed id. */
function rehypeLinkPrefixedIds() {
  type El = { type: string; tagName?: string; properties?: Record<string, unknown> };
  return (tree: HastRoot) => {
    const ids = new Set<string>();
    visit(tree, "element", (node) => {
      const id = (node as El).properties?.id;
      if (typeof id === "string") ids.add(id);
    });
    visit(tree, "element", (node) => {
      const el = node as El;
      const href = el.tagName === "a" ? el.properties?.href : undefined;
      // remark percent-encodes a link's URL (`#目標` → `#%E7%9B%AE%E6%A8%99`);
      // ids are compared as written.
      if (typeof href === "string" && href.startsWith("#") && ids.has(`${DOM_ID_PREFIX}${decodeFragment(href.slice(1))}`)) {
        el.properties!.href = `#${DOM_ID_PREFIX}${href.slice(1)}`;
      }
    });
  };
}
function decodeFragment(fragment: string): string {
  try { return decodeURIComponent(fragment); } catch { return fragment; }
}
export { findSelection, type SelectionMatch } from "./selectionMatch.js";
export { siteHead, siteLang, SITE_LOCALES, type SiteLocale, renderHeadTags, ga4InlineScript, isGa4Id, type HeadTag, type SiteHeadSite, type SiteHeadOptions, type SiteHeadVariant } from "./siteHead.js";
export {
  splitParagraphs, alignParagraphs, pairParagraphs, matchParagraphs, findParagraph, paragraphOccurrence, summarizeAlignment, paragraphSample, summarizeChange, sameTextIgnoringIds, similarity as paragraphSimilarity, SUMMARY_SECTIONS,
  type Paragraph, type ParagraphKind, type Alignment, type ChangeSummary,
  bigrams,
} from "./paragraphs.js";

export type { BridgeRequest, BridgeSaveState, BootFailureKind, BootReport, BrowserAppMedia, BrowserAppState, ToWorker, FromWorker } from "./browserBridge.js";
export { BROWSER_APP_LOCK, BROWSER_APP_STATE_PATH, BROWSER_APP_CLEAR_SAMPLES_PATH, BROWSER_APP_TEMP_PARAM, BROWSER_APP_LANG_PARAM, TEMP_SESSION_MEDIA_LIMIT_BYTES } from "./browserBridge.js";

export { STEPS_LANG, STEPS_TEMPLATE, parseSteps, usesSteps, expandSteps, type Step, type StepsDoc } from "./stepsBlocks.js";
export { alignLines, type LineAlignment } from "./lineAlign.js";
export { stepForKey, swipeStep } from "./stepsNav.js";
