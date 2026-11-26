// The 「手寫」 tab of a note whose pages are listed in `note_pages` (modules/handwriting/notePagesBook.ts): the same notebook surface
// (components/InkNodeView over the page book) with a page's file as its background, one PDF open per file. Loaded only for such a
// note, so pdf.js stays off the path of an ordinary 「手寫」 tab.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { insertBlankPage, notePagesFiles, encodeNotePages, type NotePages } from "@onden/markdown/note-pages";
import { noteDoc, type InkPages } from "@onden/markdown/ink";
import InkNodeView, { type PageBookApi } from "../../components/InkNodeView";
import { PdfPageBackground, usePdfDocument, usePdfPageShapes, type LoadedPdf } from "../../components/pdf";
import { saveNotePages, type InkSaveOptions } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { buildNoteBook, pagesToStore, type FileState } from "./notePagesBook";

type Props = {
  nodeId: string;
  list: NotePages;
  /** note_pages as stored (the base of a write that changes the list). */
  listValue: string;
  stored: InkPages;
  readOnly: boolean;
  readOnlyNotice?: string;
  save: (doc: NonNullable<ReturnType<typeof noteDoc>>, options?: InkSaveOptions) => void;
  /** At pen-up: the note's drawing holding only the strokes just drawn, stored the way `save` stores (lib/ink/surfaceSaver keepAdded). */
  keepAdded?: (doc: NonNullable<ReturnType<typeof noteDoc>>) => void;
};

type Opened = { state: FileState; pdf: LoadedPdf | null };

/** Opens one file and says what it found; draws nothing. */
function PdfFile({ file, onOpened }: { file: string; onOpened: (file: string, opened: Opened) => void }) {
  const { pdf, error } = usePdfDocument(file);
  const shapes = usePdfPageShapes(pdf?.doc ?? null);
  useEffect(() => {
    if (error) onOpened(file, { state: { status: "missing" }, pdf: null });
    else if (pdf && shapes) onOpened(file, { state: { status: "ready", shape: { count: shapes.count, ratio: shapes.ratio } }, pdf });
  }, [file, pdf, shapes, error, onOpened]);
  return null;
}

export default function NotePagesBook({ nodeId, list: initialList, listValue, stored, readOnly, readOnlyNotice, save, keepAdded }: Props) {
  const t = useT();
  const [list, setList] = useState(initialList);
  const listValueRef = useRef(listValue);
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const onOpened = useCallback((file: string, next: Opened) => setOpened((cur) => (cur[file]?.state.status === next.state.status && cur[file]?.pdf === next.pdf && cur[file]?.state === next.state ? cur : { ...cur, [file]: next })), []);
  const files = useMemo(() => notePagesFiles(list), [list]);
  const states = useMemo(() => Object.fromEntries(Object.entries(opened).map(([file, o]) => [file, o.state])), [opened]);
  const book = useMemo(() => buildNoteBook(list, stored, states), [list, stored, states]);
  // The surface lays its pages out once, when the files are open (or known to be missing); a page's shape that is read later only changes its size.
  const laidOut = useRef<{ pages: InkPages } | null>(null);
  if (book.settled && !laidOut.current) laidOut.current = { pages: book.pages };
  const bookApi = useRef<PageBookApi | null>(null);
  const bookRef = useRef(book);
  bookRef.current = book;

  const persist = (edited: InkPages, options?: InkSaveOptions) => {
    const doc = noteDoc(pagesToStore(edited, bookRef.current));
    if (doc && !readOnly) save(doc, options);
  };
  const keep = (added: InkPages) => {
    const doc = noteDoc(pagesToStore(added, bookRef.current));
    if (doc && !readOnly) keepAdded?.(doc);
  };
  // "+ Add page": the list is written first, then the page is added to the surface under the key the list gave it.
  const newPageKey = (pages: InkPages): string | null => {
    const added = insertBlankPage(list, "end", Object.keys(pages.pages));
    if (!added) return null;
    const value = encodeNotePages(added.pages);
    saveNotePages(nodeId, value, listValueRef.current);
    listValueRef.current = value;
    setList(added.pages);
    return added.key;
  };

  return (
    <>
      {files.map((file) => <PdfFile key={file} file={file} onOpened={onOpened} />)}
      {book.missing.length > 0 && <p className="handwriting-pane-notice" role="status">{t("A PDF of this note is not on this device yet. It appears when you are online.")}</p>}
      {laidOut.current && (
        <InkNodeView
          key={nodeId}
          initialPages={laidOut.current.pages}
          onPagesChange={persist}
          onAdded={keep}
          readOnly={readOnly}
          readOnlyNotice={readOnlyNotice}
          nodeId={nodeId}
          pageSizes={book.sizes}
          newPageKey={newPageKey}
          onBookReady={(api) => { bookApi.current = api; }}
          background={(record, { box, near }) => {
            const pdf = bookRef.current.entries.get(record.key)?.pdf;
            if (bookRef.current.unlisted.has(record.key)) return <p className="handwriting-unlisted-note">{t("This page is not in the note's page list.")}</p>;
            const open = pdf && opened[pdf.file]?.pdf;
            if (!pdf || !open) return null;
            return <PdfPageBackground pdf={open} pageNumber={pdf.page} box={box} near={near} onGoToPage={(n) => {
              const target = [...bookRef.current.entries.values()].find((e) => e.pdf?.file === pdf.file && e.pdf.page === n);
              if (target) bookApi.current?.scrollToPage(target.key);
            }} />;
          }}
        />
      )}
      {!laidOut.current && <div className="handwriting-pane" aria-busy="true" />}
    </>
  );
}
