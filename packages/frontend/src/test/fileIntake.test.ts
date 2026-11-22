import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateNote } from "../lib/data";

const extractPdfText = vi.fn();
vi.mock("../lib/pdf/extractText", async (original) => ({ ...(await original<typeof import("../lib/pdf/extractText")>()), extractPdfText: (file: File) => extractPdfText(file) }));

const { makeNoteFromFile, newNoteResult, goesIntoNote, NEW_NOTE_ACCEPT, INTO_NOTE_ACCEPT, PDF_NOTE_ACCEPT } = await import("../lib/fileIntake");
const { createPdfNote, PDF_TEXT_FAILED_MESSAGE } = await import("../lib/pdf/pdfNote");
const { createKindsFor } = await import("../lib/createKinds");
const { INSERT_MEDIA_ACCEPT, splitDroppedFiles } = await import("../lib/mediaInsert");

const file = (name: string, type = "") => new File(["x"], name, { type });
const KINDS = [
  { name: "paper.pdf", type: "application/pdf", note: "pdf-note", inline: false },
  { name: "photo.png", type: "image/png", note: "embed-note", inline: true },
  { name: "talk.mp3", type: "audio/mpeg", note: "embed-note", inline: true },
  { name: "clip.mp4", type: "video/mp4", note: "embed-note", inline: true },
  { name: "report.docx", type: "", note: "link-note", inline: false },
  { name: "sheet.xlsx", type: "", note: "link-note", inline: false },
  { name: "mail.eml", type: "", note: "link-note", inline: false },
  { name: "readme.txt", type: "text/plain", note: "link-note", inline: false },
] as const;

describe("the one definition: file kind → what is made", () => {
  beforeEach(() => { extractPdfText.mockReset(); extractPdfText.mockResolvedValue({ status: "text", text: "Hello paper" }); });

  it.each(KINDS)("$name: every entry makes the same new note, and the picker accepts it", async ({ name, type, note, inline }) => {
    const f = file(name, type);
    expect(newNoteResult(f)).toBe(note);
    expect(goesIntoNote(f)).toBe(inline);
    expect(NEW_NOTE_ACCEPT).toContain(name.slice(name.lastIndexOf(".")));

    // the editor's drop (and the `/` menu's PDF page): the door calls makeNoteFromFile with its own create
    const dropped: CreateNote[] = [];
    await makeNoteFromFile(f, { upload: async () => "/api/media/m1", create: async (i) => { dropped.push(i); return i; }, notify: vi.fn() });
    // the create sheet's 「上傳檔案」 (and the phone's file picker): the real entry from createKinds
    const sheet: CreateNote[] = [];
    await createKindsFor(() => true).find((k) => k.id === "upload")!.run({
      pickAndUpload: (accept: string, after: (f: File, u: () => Promise<string>) => Promise<string>) => { expect(accept).toBe(NEW_NOTE_ACCEPT); return after(f, async () => "/api/media/m1"); },
      createNote: async (i: CreateNote) => { sheet.push(i); return "id"; }, notify: vi.fn(),
    } as never);
    expect(sheet).toEqual(dropped);
    expect(dropped).toHaveLength(1);
    if (note === "pdf-note") expect(dropped[0]).toMatchObject({ markdown: "```\nHello paper\n```\n", attributes: [{ key: "pdf_url", value: "/api/media/m1" }] });
    else expect(dropped[0]!.markdown).toBe(`${note === "embed-note" ? "!" : ""}[${name.replace(/\.[^.]+$/, "")}](/api/media/m1)\n`);
    expect(dropped[0]!.attributes).toEqual(note === "pdf-note" ? [{ key: "pdf_url", value: "/api/media/m1" }] : undefined);

    // into the open note's text: a drop splits the file the way the definition says
    const split = splitDroppedFiles([f]);
    expect(split.media.length === 1).toBe(inline);
  });

  it("the pickers' accept values come from the definition", () => {
    expect(INSERT_MEDIA_ACCEPT).toBe(INTO_NOTE_ACCEPT);
    expect(PDF_NOTE_ACCEPT).toContain(".pdf");
    expect(PDF_NOTE_ACCEPT).not.toContain(".docx");
  });

  it("a file nothing takes makes no note", async () => {
    expect(newNoteResult(file("archive.zip"))).toBeNull();
    await expect(makeNoteFromFile(file("archive.zip"), { upload: async () => "/u", create: vi.fn(), notify: vi.fn() })).rejects.toThrow();
  });
});

describe("a PDF note's text", () => {
  beforeEach(() => { extractPdfText.mockReset(); extractPdfText.mockResolvedValue({ status: "text", text: "Hello paper" }); });
  const pdf = file("First_English.pdf", "application/pdf");

  it("tells the person once when the text could not be read, but still makes the note", async () => {
    extractPdfText.mockResolvedValue({ status: "failed", text: "" });
    const notify = vi.fn(); const create = vi.fn(async () => "id");
    await createPdfNote(pdf, { upload: async () => "/u", create, notify });
    expect(create).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe(PDF_TEXT_FAILED_MESSAGE);
  });
  it("says nothing for a scan (no text layer)", async () => {
    extractPdfText.mockResolvedValue({ status: "none", text: "" });
    const notify = vi.fn();
    await createPdfNote(pdf, { upload: async () => "/u", create: async () => "id", notify });
    expect(notify).not.toHaveBeenCalled();
  });
  it("makes no note when the upload fails", async () => {
    const create = vi.fn();
    await expect(createPdfNote(pdf, { upload: async () => { throw new Error("x"); }, create, notify: vi.fn() })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("a PDF's own text is only text in its note", () => {
  it("links, attributes and tags written in the paper are not read as the note's own", async () => {
    const { wikilinkBodies, attributeLines } = await import("@onden/markdown");
    const paper = "See [[1]] and [[Some Note|x]].\n#year=2020\nauthor:: Someone\nA [k:: v] inline.\n```\nfence inside the paper\n```\n";
    extractPdfText.mockResolvedValue({ status: "text", text: paper });
    const made: CreateNote[] = [];
    await createPdfNote(file("p.pdf", "application/pdf"), { upload: async () => "/u", create: async (i) => { made.push(i); return i; }, notify: vi.fn() });
    const body = made[0]!.markdown!;
    expect(wikilinkBodies(body)).toEqual([]);
    expect(attributeLines(body)).toEqual([]);
    expect(body.replace(/\u200b/g, "")).toContain("[[1]]"); // the words are all still there for search and the AI
    expect(body).toContain("author:: Someone");
  });
});

describe("reading stops at the text limit", () => {
  it("does not read the pages after the limit", async () => {
    const { extractTextFromDocument, PDF_TEXT_CHAR_LIMIT } = await import("../lib/pdf/extractText");
    const getPage = vi.fn(async () => ({ getTextContent: async () => ({ items: [{ str: "x".repeat(PDF_TEXT_CHAR_LIMIT / 2) }] }) }));
    const text = await extractTextFromDocument(new ArrayBuffer(1), () => ({ promise: Promise.resolve({ numPages: 100, getPage }) }));
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(text.length).toBeLessThanOrEqual(PDF_TEXT_CHAR_LIMIT);
  });
});
