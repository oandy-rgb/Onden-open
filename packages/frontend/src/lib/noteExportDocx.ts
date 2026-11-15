import { expandSteps, mediaRefs, parseExportTree, parseCalloutMarker, embedLabel, embedMatches, hasSafeLinkScheme } from "@onden/markdown";
import type { FileChild, ParagraphChild } from "docx";
import { reads } from "./data";
import { t } from "./i18n";
import { displayTitle } from "./noteLabel";
import type { NoteExportOptions, NoteExportSnapshot } from "./noteExport";

// The note as a Word file. Not a second Markdown parser: the tree comes from
// @onden/markdown (parseExportTree), the same syntax the page and the HTML
// export read. This file only maps that tree to Word. The `docx` package is
// loaded when the user asks for Word (import() below), never at boot.
//
// Word edits stay in Word: nothing here reads a .docx back.

/** The font family the file is set in: 黑體 "sans" (Microsoft JhengHei) or 明體 "serif" (PMingLiU). */
export type DocxFont = NonNullable<NoteExportOptions["font"]>;

export type DocxMedia = { bytes: Uint8Array; kind: "png" | "jpg" | "gif"; width: number; height: number };

export type DocxOptions = {
  font?: DocxFont;
  /** The media file `id` points at, or null when it cannot be had (the picture then becomes its alt text). */
  loadMedia?: (id: string) => Promise<DocxMedia | null>;
};

// Face names Word and LibreOffice both know. The East Asian slot is set along
// with the Latin ones, or Word falls back to the default Latin font for Chinese
// text and shows it in a Simplified-Chinese face.
const FONTS: Record<DocxFont, string> = { sans: "Microsoft JhengHei", serif: "PMingLiU" };
const MONO = "Consolas";
const TEXT_WIDTH = 9070; // twips: A4 (11906) less 2.5 cm margins
const MAX_IMAGE_PX = 600; // A4 with 2.5 cm margins is ~ 6.3 in of 96-dpi text width

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mdast plus the wikiLink/math/footnote nodes the packages' plugins add; read by field
type Node = { type: string; children?: Node[]; [key: string]: any }; // mdast + wikiLink/math/footnote nodes

type Marks = Partial<Record<"bold" | "italics" | "strike" | "code" | "link", boolean>>;

/** The image's pixel size from its header (PNG, JPEG, GIF), or null for another kind. Word needs the size to place a picture. */
export function imageInfo(bytes: Uint8Array): Pick<DocxMedia, "kind" | "width" | "height"> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) return { kind: "png", width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { kind: "gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { kind: "jpg", height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      }
      at += 2 + view.getUint16(at + 2);
    }
  }
  return null;
}

async function fetchMedia(id: string): Promise<DocxMedia | null> {
  const bytes = await reads.notes.mediaBytes(id);
  const info = bytes && imageInfo(bytes);
  return bytes && info && info.width > 0 && info.height > 0 ? { bytes, ...info } : null;
}

/** Every `/api/media/` id a tree's images point at. */
function imageIds(node: Node, out = new Set<string>()): Set<string> {
  if (node.type === "image" && typeof node.url === "string") { const [id] = mediaRefs(node.url); if (id) out.add(id); }
  for (const child of node.children ?? []) imageIds(child, out);
  return out;
}

/** The note as a .docx file. Rejects only when Word's writer fails; a picture that cannot be fetched is written as its alt text. */
export async function noteExportDocx(snapshot: NoteExportSnapshot, options: DocxOptions = {}): Promise<Blob> {
  const docx = await import("docx");
  const font = options.font ?? "sans";
  const face = FONTS[font];
  const loadMedia = options.loadMedia ?? fetchMedia;
  const tree = parseExportTree(expandSteps(snapshot.markdown)) as unknown as Node;

  const media = new Map<string, DocxMedia | null>();
  await Promise.all([...imageIds(tree)].map(async (id) => { media.set(id, await loadMedia(id)); }));

  const footnoteIds = new Map<string, number>();
  for (const child of tree.children ?? []) if (child.type === "footnoteDefinition") footnoteIds.set(child.identifier, footnoteIds.size + 1);
  const footnotes: Record<number, { children: InstanceType<typeof docx.Paragraph>[] }> = {};
  const orderedLists: string[] = [];

  // Only a link with a safe scheme becomes one. A relative link points into the app, which a file read elsewhere cannot follow: it stays text.
  const absolute = (href: string): string | null => {
    if (!hasSafeLinkScheme(href)) return null;
    try { return new URL(href).href; } catch { return null; }
  };

  // ── inline ────────────────────────────────────────────────────────────────
  function run(text: string, marks: Marks) {
    return new docx.TextRun({
      text, bold: marks.bold || undefined, italics: marks.italics || undefined, strike: marks.strike || undefined,
      ...(marks.link ? { style: "Hyperlink" } : marks.code ? { style: "InlineCode" } : {}),
    });
  }

  function inline(nodes: Node[], marks: Marks = {}): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    nodes.forEach((node) => {
      switch (node.type) {
        case "text": {
          // `![[x]]` never reaches the wikilink syntax (CommonMark reads `![` as an image), so it is found in the text.
          // An embed is written as its name, like the HTML export's placeholder; the embedded text is not copied in.
          let last = 0;
          for (const embed of embedMatches(node.value)) {
            if (embed.start > last) out.push(run(node.value.slice(last, embed.start), marks));
            out.push(run(`↪ ${embedLabel(embed)}`, { ...marks, italics: true }));
            last = embed.end;
          }
          if (last < node.value.length) out.push(run(node.value.slice(last), marks));
          break;
        }
        case "strong": out.push(...inline(node.children ?? [], { ...marks, bold: true })); break;
        case "emphasis": out.push(...inline(node.children ?? [], { ...marks, italics: true })); break;
        case "delete": out.push(...inline(node.children ?? [], { ...marks, strike: true })); break;
        case "inlineCode": out.push(run(node.value, { ...marks, code: true })); break;
        case "inlineMath": out.push(run(node.value, { ...marks, code: true })); break; // raw TeX, not typeset
        case "break": out.push(new docx.TextRun({ break: 1 })); break;
        case "link": {
          const href = absolute(node.url);
          if (href) out.push(new docx.ExternalHyperlink({ link: href, children: inline(node.children ?? [], { ...marks, link: true }) }));
          else out.push(...inline(node.children ?? [], marks));
          break;
        }
        case "wikiLink": out.push(run(node.data?.alias || String(node.value), marks)); break; // text; the note's address is not stable outside the app
        case "footnoteReference": {
          const id = footnoteIds.get(node.identifier);
          if (id) out.push(new docx.FootnoteReferenceRun(id));
          break;
        }
        case "image": out.push(...image(node)); break;
        case "html": break; // raw HTML has no Word form
        default: out.push(...inline(node.children ?? [], marks));
      }
    });
    return out;
  }

  function image(node: Node): ParagraphChild[] {
    const alt = node.alt || t("Image");
    const [id] = mediaRefs(node.url ?? "");
    const file = id ? media.get(id) : null;
    if (!file) return [new docx.TextRun({ text: `[${alt}]`, italics: true })];
    const scale = Math.min(1, MAX_IMAGE_PX / file.width);
    return [new docx.ImageRun({
      type: file.kind, data: file.bytes, altText: { name: alt, description: alt, title: alt },
      transformation: { width: Math.round(file.width * scale), height: Math.round(file.height * scale) },
    })];
  }

  // ── blocks ────────────────────────────────────────────────────────────────
  type Frame = { indent: number; quote: boolean };
  const root: Frame = { indent: 0, quote: false };
  const quoteBorder = { left: { style: docx.BorderStyle.SINGLE, size: 18, color: "9AA5B1", space: 8 } };

  const paragraph = (children: ParagraphChild[], frame: Frame, options: Record<string, unknown> = {}) => new docx.Paragraph({
    children,
    ...(frame.quote ? { border: quoteBorder } : {}),
    ...(frame.indent ? { indent: { left: frame.indent } } : {}),
    ...options,
  });

  const HEADINGS = [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3, docx.HeadingLevel.HEADING_4, docx.HeadingLevel.HEADING_5, docx.HeadingLevel.HEADING_6];

  function blocks(nodes: Node[], frame: Frame, list?: { reference: string; level: number }): FileChild[] {
    const out: FileChild[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case "heading": out.push(paragraph(inline(node.children ?? []), frame, { heading: HEADINGS[Math.min(5, Math.max(0, node.depth - 1))] })); break;
        case "paragraph": out.push(paragraph(inline(node.children ?? []), frame, list ? { numbering: { reference: list.reference, level: list.level } } : {})); break;
        case "blockquote": {
          const callout = calloutOf(node);
          out.push(...(callout ? [callout] : blocks(node.children ?? [], { ...frame, quote: true })));
          break;
        }
        case "list": out.push(...listBlocks(node, frame, list)); break;
        case "code": out.push(...codeBlock(node.value ?? "", frame)); break;
        case "math": out.push(...codeBlock(node.value ?? "", frame)); break; // raw TeX
        case "thematicBreak": out.push(paragraph([], frame, { border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: "9AA5B1", space: 1 } } })); break;
        case "table": out.push(table(node)); out.push(new docx.Paragraph({})); break;
        case "html": break;
        case "footnoteDefinition": {
          const id = footnoteIds.get(node.identifier);
          if (id) footnotes[id] = { children: blocks(node.children ?? [], root).filter((child): child is InstanceType<typeof docx.Paragraph> => child instanceof docx.Paragraph) };
          break;
        }
        default: if (node.children) out.push(...blocks(node.children, frame, list));
      }
    }
    return out;
  }

  function listBlocks(node: Node, frame: Frame, parent?: { reference: string; level: number }): FileChild[] {
    const level = parent ? Math.min(8, parent.level + 1) : 0;
    let reference = "bullets";
    if (node.ordered) { reference = `ol-${orderedLists.length}`; orderedLists.push(reference); }
    const out: FileChild[] = [];
    for (const item of node.children ?? []) {
      const checked = typeof item.checked === "boolean";
      // A task item has a box instead of a bullet; its text hangs under the box like a list item's.
      const mark = checked ? { reference: "tasks", level } : { reference, level };
      const [first, ...rest] = item.children ?? [];
      const head = first?.type === "paragraph" ? first : null;
      const box = checked ? [new docx.TextRun({ text: item.checked ? "☑ " : "☐ " })] : [];
      out.push(paragraph([...box, ...(head ? inline(head.children ?? []) : [])], frame, { numbering: mark }));
      out.push(...blocks(head ? rest : item.children ?? [], frame, { reference, level }));
    }
    return out;
  }

  function codeBlock(code: string, frame: Frame): FileChild[] {
    return code.replace(/\n$/, "").split("\n").map((line) => paragraph(
      [new docx.TextRun({ text: line })], frame, { style: "CodeBlock" }));
  }

  /** An Obsidian callout: a one-cell table with a coloured bar and a tinted body; the title row is its type's name or the title written. */
  function calloutOf(node: Node): FileChild | null {
    const first = node.children?.[0];
    const lead = first?.type === "paragraph" ? first.children?.[0] : null;
    if (lead?.type !== "text") return null;
    const marker = parseCalloutMarker(lead.value);
    if (!marker) return null;
    const rest = lead.value.slice(marker.length);
    const [titleText = "", ...afterTitle] = rest.split("\n");
    const titleNodes: Node[] = [];
    if (titleText) titleNodes.push({ type: "text", value: titleText });
    const bodyNodes: Node[] = [];
    let titleOpen = !rest.includes("\n");
    for (const sibling of first!.children!.slice(1)) {
      if (titleOpen) { if (sibling.type === "break") titleOpen = false; else titleNodes.push(sibling); } else bodyNodes.push(sibling);
    }
    if (afterTitle.join("\n")) bodyNodes.unshift({ type: "text", value: afterTitle.join("\n") });
    const colour = CALLOUT_COLOURS[marker.type] ?? CALLOUT_COLOURS.note!;
    const title = titleNodes.length ? inline(titleNodes, { bold: true }) : [new docx.TextRun({ text: marker.name.charAt(0).toUpperCase() + marker.name.slice(1), bold: true })];
    const children: FileChild[] = [new docx.Paragraph({ children: title, style: "CalloutTitle" })];
    if (bodyNodes.length) children.push(new docx.Paragraph({ children: inline(bodyNodes) }));
    children.push(...blocks(node.children!.slice(1), root));
    const none = { style: docx.BorderStyle.NONE, size: 0, color: "FFFFFF" };
    return new docx.Table({
      width: { size: TEXT_WIDTH, type: docx.WidthType.DXA }, columnWidths: [TEXT_WIDTH],
      borders: { top: none, bottom: none, right: none, insideHorizontal: none, insideVertical: none, left: { style: docx.BorderStyle.SINGLE, size: 24, color: colour.bar } },
      rows: [new docx.TableRow({ cantSplit: true, children: [new docx.TableCell({
        shading: { type: docx.ShadingType.CLEAR, fill: colour.fill, color: "auto" },
        margins: { top: 80, bottom: 80, left: 160, right: 120 },
        children,
      })] })],
    });
  }

  function table(node: Node): FileChild {
    const align = (node.align ?? []) as (string | null)[];
    const rows = (node.children ?? []).map((row, rowIndex) => new docx.TableRow({
      tableHeader: rowIndex === 0, cantSplit: true,
      children: (row.children ?? []).map((cell, column) => new docx.TableCell({
        shading: rowIndex === 0 ? { type: docx.ShadingType.CLEAR, fill: "EEF1F4", color: "auto" } : undefined,
        children: [new docx.Paragraph({
          children: inline(cell.children ?? [], rowIndex === 0 ? { bold: true } : {}),
          alignment: align[column] === "center" ? docx.AlignmentType.CENTER : align[column] === "right" ? docx.AlignmentType.RIGHT : undefined,
        })],
      })),
    }));
    const columns = Math.max(1, (node.children?.[0]?.children ?? []).length);
    // Explicit widths: LibreOffice lays columns out by the grid, not by the table's percentage.
    return new docx.Table({ width: { size: TEXT_WIDTH, type: docx.WidthType.DXA }, columnWidths: Array(columns).fill(Math.floor(TEXT_WIDTH / columns)), rows });
  }

  const body = blocks(tree.children ?? [], root);
  const title = new docx.Paragraph({ text: displayTitle(snapshot.title), heading: docx.HeadingLevel.TITLE });

  const fonts = (name: string) => ({ ascii: name, hAnsi: name, cs: name, eastAsia: name });
  const bulletGlyphs = ["•", "◦", "▪"];
  const levels = (format: "bullet" | "decimal") => Array.from({ length: 9 }, (_, level) => ({
    level, format: format === "bullet" ? docx.LevelFormat.BULLET : docx.LevelFormat.DECIMAL,
    text: format === "bullet" ? bulletGlyphs[level % 3]! : `%${level + 1}.`,
    alignment: docx.AlignmentType.START,
    style: { paragraph: { indent: { left: 360 + level * 360, hanging: 360 } } },
  }));
  const taskLevels = Array.from({ length: 9 }, (_, level) => ({
    level, format: docx.LevelFormat.NONE, text: "", alignment: docx.AlignmentType.START,
    style: { paragraph: { indent: { left: 360 + level * 360, hanging: 0 } } },
  }));

  const document = new docx.Document({
    title: snapshot.title,
    // Styles carry the look; no paragraph sets a font of its own, so changing the Normal style in Word restyles the file.
    styles: {
      default: {
        document: { run: { font: fonts(face), size: 22, language: { value: "en-US", eastAsia: "zh-TW" } }, paragraph: { spacing: { after: 120, line: 320 } } },
        title: { run: { font: fonts(face), size: 44, bold: true }, paragraph: { spacing: { after: 240 } } },
        heading1: { run: { font: fonts(face), size: 36, bold: true }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font: fonts(face), size: 30, bold: true }, paragraph: { spacing: { before: 300, after: 100 } } },
        heading3: { run: { font: fonts(face), size: 26, bold: true }, paragraph: { spacing: { before: 240, after: 80 } } },
        heading4: { run: { font: fonts(face), size: 24, bold: true }, paragraph: { spacing: { before: 200, after: 60 } } },
        heading5: { run: { font: fonts(face), size: 22, bold: true }, paragraph: { spacing: { before: 160, after: 40 } } },
        heading6: { run: { font: fonts(face), size: 22, bold: true, color: "5F6B7A" }, paragraph: { spacing: { before: 160, after: 40 } } },
        hyperlink: { run: { color: "0563C1", underline: { type: docx.UnderlineType.SINGLE } } },
      },
      paragraphStyles: [
        { id: "CodeBlock", name: "Code Block", basedOn: "Normal", quickFormat: true,
          run: { font: { ...fonts(MONO), eastAsia: face }, size: 20 },
          paragraph: { spacing: { after: 0, line: 260 }, shading: { type: docx.ShadingType.CLEAR, fill: "F3F4F6", color: "auto" } } },
        { id: "CalloutTitle", name: "Callout Title", basedOn: "Normal", run: { bold: true }, paragraph: { spacing: { after: 60 } } },
      ],
      characterStyles: [
        { id: "InlineCode", name: "Inline Code", run: { font: { ...fonts(MONO), eastAsia: face }, size: 20, shading: { type: docx.ShadingType.CLEAR, fill: "F3F4F6", color: "auto" } } },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: levels("bullet") },
        { reference: "tasks", levels: taskLevels },
        ...orderedLists.map((reference) => ({ reference, levels: levels("decimal") })),
      ],
    },
    footnotes,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1418, bottom: 1418, left: 1418, right: 1418 } } },
      children: [title, ...body],
    }],
  });
  return docx.Packer.toBlob(document);
}

const CALLOUT_COLOURS: Record<string, { bar: string; fill: string }> = {
  note: { bar: "4C8DD6", fill: "EAF3FC" }, abstract: { bar: "3FA7B5", fill: "E7F6F8" }, info: { bar: "4C8DD6", fill: "EAF3FC" },
  todo: { bar: "4C8DD6", fill: "EAF3FC" }, tip: { bar: "2FA38A", fill: "E6F6F2" }, success: { bar: "4CAF50", fill: "E9F6EA" },
  question: { bar: "D9A21B", fill: "FDF5E0" }, warning: { bar: "E88B2E", fill: "FDEFE0" }, failure: { bar: "D9534F", fill: "FBE9E8" },
  danger: { bar: "D9534F", fill: "FBE9E8" }, bug: { bar: "D9534F", fill: "FBE9E8" }, example: { bar: "8E6BC9", fill: "F1EBFA" },
  quote: { bar: "9AA5B1", fill: "F2F4F6" },
};
