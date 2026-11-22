// Quick capture (記一筆): open it, type, send. Nothing is asked first — not what
// kind of note, not where it goes.
//
// Where a capture goes is shown as one quiet line above the box (「放進：收件匣」).
// With no place named it goes to the account's one setting (captureDestination:
// the inbox, today's journal, or one note), which is changed in Settings and
// nowhere else. Tapping the line picks a place for THIS capture only; it is
// forgotten after the next send, so the line never remembers a place behind the
// person's back and never follows the note that happens to be open.
//
// A capture is a real note (it can be tagged, linked, filed): the typed text is
// its body and its first line the title. In the inbox it is a top-level note
// with the capture module's tag and the `_captured` flag, created in ONE
// request (tag_ids + attributes), so it never exists half-made. The text may
// carry a #tag, a [[note, or a day word (captureText.ts); all optional.
//
// The box clears after a send and stays open for the next one. The text is a
// draft kept across closing and reloading (cleared by a send); a failed send
// keeps it and the client ids, so a retry cannot make a second note.
//
// Other kinds (handwriting, a file or photo, a bookmark) are the small icons
// beside the box: they create through the shared create entry
// (hooks/useNodeCreation), then give the new note the same place. 「更多…」 opens
// the full create sheet.
//
// Web Speech API is wired with a runtime feature-check; where it exists the mic
// toggle appears. Recognition results are appended live as interim text and
// committed on `result.isFinal` so the textarea stays the source of truth.

import { randomUUID } from "../../lib/uuid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageOff, Mic, MicOff, X } from "lucide-react";
import { getLocale, systemLanguageTag } from "../../lib/i18n";
import { getApiBase, type ContentNode, type Tag } from "../../lib/api";
import { addToast } from "../../lib/appStore";
import { canPlaceUnder, dayNotes, findTagIdByPath, noteWriter, propertyWriter, tagWriter, uploadMedia, usePendingWrites, writeErrors } from "../../lib/data";
import type { IncomingShare } from "../../lib/share";
import { useT } from "../../lib/i18n";
import { useCapabilities } from "../../lib/capabilities";
import { formatChord } from "../../lib/shortcuts";
import { useDailyNotesEnabled, useTasksEnabled } from "../../hooks/useModuleFilter";
import { PREFS, getPref, removePref, setPref } from "../../lib/prefs";
import { canHoldNewNotes } from "../../lib/newNoteTarget";
import type { CreateKind } from "../../lib/createKinds";
import { isSystemTag } from "../../lib/systemNodes";
import { isEnterKey } from "../../lib/keys";
import { dayAndClock } from "../../lib/localDate";
import type { CreateFn } from "../../hooks/useNodeCreation";
import { Button, Img, Pressable, Sheet, SheetHeader, TextArea } from "../../components/ui";
import { ellipsize } from "@onden/markdown";
import { noteNamed } from "../../lib/noteNamed";
import { createQuickTask, quickTaskFromReading } from "../taskParts";
import CaptureWherePicker from "./CaptureWherePicker";
import { captureDestinationPref, captureDestinationWords, destinationOf, usableDestination, type CaptureDestination } from "./captureDestination";
import { readCapture, withoutLink } from "./captureText";
import { CAPTURED_ATTRIBUTE, ensureInboxTagId, inboxTagId } from "./inbox";
import { OPEN_QUICK_CAPTURE_EVENT } from "./openQuickCapture";
import "./QuickCapture.css";
import { displayTitle } from "../../lib/noteLabel";
import { onWindow } from "../../lib/globalEvents";
import { windowGlobal } from "../../lib/pageEnvironment";
import { useHasKeyboard } from "../../hooks/useKbdHint";

// The typed text outlives closing the sheet and reloading the page: Esc, the
// close button and a click outside only hide it. Cleared by a successful send
// or by deleting the text. Scoped to the signed-in account.
// If storage is unavailable the draft lives until the page closes.
function loadDraft(): string {
  return getPref(PREFS.quickCaptureDraft) ?? "";
}

function storeDraft(text: string): void {
  if (text.trim()) setPref(PREFS.quickCaptureDraft, text); else removePref(PREFS.quickCaptureDraft);
}

export type QuickCaptureProps = {
  online: boolean;
  nodes: ContentNode[];
  tags: Tag[];
  /** The shared create entry (hooks/useNodeCreation) and the kinds it lists
   *  (lib/createKinds): the small icons beside the box make these. */
  create: CreateFn;
  kinds: readonly CreateKind[];
  /** 「更多…」: the full create sheet (the shell's); the box closes, its draft kept. */
  onMore: () => void;
  /** Reload the notes (after the inbox tag was made, so it joins the tag list). */
  onRefresh: () => Promise<void> | void;
  /** Web Share Target hand-off: when non-null the sheet opens on mount with
   *  this text already in the box (BuilderApp consumes `?capture=1&title=&
   *  text=&url=` once at boot and passes the joined payload down). */
  initialDraft?: string | null;
  /** 「分享 → Onden」 (lib/share/shareInbox.ts): each new share opens the
   *  sheet with its text added to the box and its images attached; when the
   *  page title arrives (`titledDraft`) it replaces the inserted text. */
  share?: IncomingShare | null;
  /** Open on mount: QuickCaptureHost mounts the box on the first request to open it. */
  startOpen?: boolean;
};

// An attached image's markdown, as the editor inserts an uploaded image
// (OverviewEditor): the native app needs the server's address in front.
function imageMarkdown(file: File, url: string): string {
  const base = getApiBase();
  const src = url.startsWith("/") && base ? `${base}${url}` : url;
  const alt = file.name.replace(/\.[^.]+$/, "").replace(/^shared-\d+$/, "").replace(/[[\]]/g, "");
  return `![${alt}](${src})`;
}

/** A thumbnail of an image waiting to be uploaded with the capture. */
function AttachedImage({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <li className="quick-capture-image">
      {src ? <Img src={src} alt={file.name} /> : <span className="quick-capture-image-name">{file.name}</span>}
      <Pressable
        type="button"
        className="quick-capture-image-remove"
        onClick={onRemove}
        disabled={disabled}
        aria-label={t("Remove image {name}", { name: file.name })}
      >
        <X size={12} />
      </Pressable>
    </li>
  );
}

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> & { length: number } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type RecognitionCtor = new () => Recognition;

function getRecognitionCtor(): RecognitionCtor | null {
  return windowGlobal<RecognitionCtor>("SpeechRecognition") ?? windowGlobal<RecognitionCtor>("webkitSpeechRecognition") ?? null;
}

function nowTimeString(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// A captured node's title = its first line (trimmed), so the node is findable
// at a glance; falls back to the capture time for a bodyless/odd input.
function deriveTitle(text: string): string {
  const first = text.trim().split("\n", 1)[0]!.trim();
  if (!first) return nowTimeString();
  return ellipsize(first, 60);
}

/** The other kinds, from the shared create list (lib/createKinds). */
const KIND_IDS = ["ink", "upload", "bookmark"] as const;

/** Where a capture lands, once its place is settled: under a note, or in the inbox. */
type Landing = { parentId: string | null; inbox: boolean };

export default function QuickCapture({ online, nodes, tags, create, kinds: allKinds, onMore, onRefresh, initialDraft = null, share = null, startOpen = false }: QuickCaptureProps) {
  const hasKeyboard = useHasKeyboard();
  const t = useT();
  const journalOn = useDailyNotesEnabled();
  const tasksOn = useTasksEnabled();
  captureDestinationPref.useKeepInSync();
  const { value: storedDestination } = captureDestinationPref.useValue();
  // Live count of queued, not-yet-synced writes — lets the offline hint name a
  // CONCRETE number ("N waiting to sync") instead of a vague reassurance, so a
  // capture made offline is verifiably safe (reads the existing pending-writes
  // store; no parallel queue).
  const pendingWrites = usePendingWrites();
  // A share-target arrival opens the sheet immediately, prefilled — the whole
  // point of "share to Onden" is zero extra taps before the text is editable.
  const [open, setOpen] = useState(initialDraft != null || startOpen);
  const [text, setText] = useState(() => {
    const saved = loadDraft();
    // A shared item never replaces an unsaved draft; it goes after it.
    if (!initialDraft?.trim()) return saved || (initialDraft ?? "");
    return saved.trim() ? `${saved}\n\n${initialDraft}` : initialDraft;
  });
  useEffect(() => { storeDraft(text); }, [text]);
  const [busy, setBusy] = useState(false);
  // Images attached by a share. They upload on send (uploads are online-only:
  // a file is too large for the offline write queue, lib/data/media.ts), and
  // live until the page closes — unlike the text, they are not kept as a draft.
  const [images, setImages] = useState<File[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  // Uploaded addresses, so a retried send does not upload an image twice.
  const uploadedRef = useRef(new Map<File, string>());
  // The share last put in the box, and whether its fetched title was used.
  const appliedShareRef = useRef<{ id: number; titled: boolean } | null>(null);
  useEffect(() => {
    if (!share) return;
    const applied = appliedShareRef.current;
    if (applied?.id !== share.id) {
      appliedShareRef.current = { id: share.id, titled: share.titledDraft != null };
      const draft = share.titledDraft ?? share.draft;
      // Like the GET hand-off: a share never replaces what is in the box.
      if (draft) setText((current) => current.trim() ? `${current}\n\n${draft}` : draft);
      if (share.images.length) setImages((current) => [...current, ...share.images]);
      setSkipped(share.skipped);
      setOpen(true);
      return;
    }
    // The page title came after the sheet opened: swap it in, unless the
    // user already changed that text.
    const { draft, titledDraft } = share;
    if (!applied.titled && titledDraft && draft) {
      applied.titled = true;
      setText((current) => current.includes(draft) ? current.replace(draft, titledDraft) : current);
    }
  }, [share]);

  const { canEdit } = useCapabilities(online);
  // A note may hold a capture when it exists, is a plain note (not a tag, a
  // board or a system row) and this person may write under it (lib/data
  // placement, audit D101): the server refuses a note under a tag (409) and a
  // note in a space where the person only reads (403).
  const noteCanHold = useCallback((noteId: string) => {
    const note = nodes.find((n) => n.id === noteId);
    return !!note && canHoldNewNotes(note) && canPlaceUnder(note, undefined, { canEdit });
  }, [nodes, canEdit]);
  // The account's setting, or — for this capture only — what was picked on the
  // line above the box. The pick is dropped after a send.
  const [picked, setPicked] = useState<CaptureDestination | null>(null);
  const destination = useMemo(
    () => usableDestination(picked ?? destinationOf(storedDestination), { journalOn, noteCanHold }),
    [picked, storedDestination, journalOn, noteCanHold],
  );
  const placeName = captureDestinationWords(destination, nodes);
  const [choosing, setChoosing] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  // Stable snapshot of the typed text when recording started — so interim
  // results can be appended without overwriting whatever the user already
  // had in the box.
  const baselineRef = useRef("");
  // Client ids for the capture being attempted; reused while the input is the
  // same so a retry cannot create a second note (see send below).
  const attemptRef = useRef<{ key: string; captureId: string; dailyId: string } | null>(null);

  const speechAvailable = getRecognitionCtor() !== null;

  // F5.2 — global ⌘⇧N, the phone's ＋ and the palette open the box. A custom
  // event keeps those callers out of this component's state (openQuickCapture).
  useEffect(() => {
    const handler = () => { setSavedTo(null); setOpen(true); };
    return onWindow(OPEN_QUICK_CAPTURE_EVENT, handler);
  }, []);

  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    };
  }, []);

  const stopListening = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = systemLanguageTag();
    baselineRef.current = text;
    rec.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalChunk += r[0].transcript;
        else interimChunk += r[0].transcript;
      }
      const baseline = baselineRef.current;
      const joined = `${baseline}${baseline && finalChunk ? " " : ""}${finalChunk}${interimChunk ? ` ${interimChunk}` : ""}`;
      setText(joined.trim());
      if (finalChunk) baselineRef.current = `${baseline}${baseline ? " " : ""}${finalChunk}`.trim();
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws if called while another instance is running
      setListening(false);
    }
  }, [text]);

  // What the words mean, shown before sending so a dated line is not a surprise.
  const reading = useMemo(() => {
    return readCapture(text, { ...dayAndClock(), locale: getLocale(), tasksOn });
  }, [text, tasksOn]);
  const becomesTask = reading.task !== null && images.length === 0;

  /** Settles where a capture goes: the note it goes under (today's journal is
   *  found or started first), or the inbox. Needs the inbox tag's id for the
   *  inbox, which the server makes the first time. */
  const landingFor = useCallback(async (place: CaptureDestination, dailyId: string): Promise<Landing & { tagId: string | null }> => {
    if (place.kind === "note") return { parentId: place.noteId, inbox: false, tagId: null };
    if (place.kind === "today") {
      // Found or started like the topbar's Today button: sent now when online,
      // queued otherwise; a refusal rejects (already reported by the writer).
      // `dailyId` is only used before the personal space is known.
      const today = await dayNotes.openToday({ fallbackId: dailyId });
      return { parentId: today!.node.id, inbox: false, tagId: null };
    }
    return { parentId: null, inbox: true, tagId: await ensureInboxTagId(tags) };
  }, [tags]);

  // Capture mints a REAL NOTE: the typed text is its body, the first line its
  // title — so it is immediately taggable, linkable and fileable. The note is
  // created by the note writer, so it enters the store and the local mirror at
  // once and a capture made offline is queued and replayed on reconnect. We mint
  // client-side UUIDs up front, so a queued POST carries a known id.
  //
  // Until the note is accepted (or durably queued), a failure keeps the input
  // for a retry, and the retry reuses the same client ids so it can never
  // create a second note or day note. Once it is accepted the capture is done.
  // The one thing offline cannot do: the first capture to the inbox needs the tag the server makes. Save refuses (text kept),
  // and the hint under the box must say so instead of promising "saved locally".
  const inboxNeedsConnection = destination.kind === "inbox" && !online && !inboxTagId(tags) && !reading.link;
  const send = useCallback(async () => {
    if ((!text.trim() && images.length === 0) || busy) return;
    if (images.length > 0 && !online) {
      addToast(t("Images need a connection to upload. Connect, then save — or remove the images."), "error");
      return;
    }
    // The inbox's tag is made by the server the first time; without a
    // connection there is no tag to put the note in yet. Nothing is lost:
    // the text stays in the box.
    if (inboxNeedsConnection) {
      addToast(t("Connect once to set up the inbox. Your text is kept."), "error");
      return;
    }
    if (listening) stopListening();
    setBusy(true);
    let savedPlace = placeName;
    let madeTask = false;
    let madeInboxTag = false;
    try {
      // Shared images upload first and go under the text as image embeds.
      const embeds: string[] = [];
      for (const file of images) {
        let url = uploadedRef.current.get(file);
        if (!url) {
          url = await uploadMedia(file);
          uploadedRef.current.set(file, url);
        }
        embeds.push(imageMarkdown(file, url));
      }

      if (reading.task && embeds.length === 0) {
        // "tomorrow 3pm hand in the report": a task, as the Tasks quick-add makes it.
        await createQuickTask(quickTaskFromReading(reading.task));
        madeTask = true;
      } else {
        // [[note: honoured when the note is found and a capture may go under it.
        let place = destination;
        let words = reading.text;
        if (reading.link) {
          const target = await noteNamed(reading.link.name, noteCanHold);
          if (target) {
            place = { kind: "note", noteId: target.id };
            savedPlace = displayTitle(target.title);
            words = withoutLink(words, reading.link.token);
          }
        }
        const body = [words, embeds.join("\n")].filter(Boolean).join("\n\n");
        // Same input → same ids, so a retry after a refused or lost request is
        // deduplicated by the server (the id doubles as the Idempotency-Key).
        const attemptKey = `${place.kind}:${place.kind === "note" ? place.noteId : ""}\u0000${reading.text}\u0000${embeds.join("\n")}`;
        if (attemptRef.current?.key !== attemptKey) {
          attemptRef.current = { key: attemptKey, captureId: randomUUID(), dailyId: randomUUID() };
        }
        const { captureId, dailyId } = attemptRef.current;
        const hadInboxTag = inboxTagId(tags) !== null;
        const landing = await landingFor(place, dailyId);
        madeInboxTag = landing.inbox && !hadInboxTag;
        // #tags that exist are applied in the same request; the others stay text.
        const textTagIds = reading.tagPaths.flatMap((path) => {
          const id = findTagIdByPath(tags, path);
          const tag = tags.find((candidate) => candidate.id === id);
          return id && tag && !isSystemTag(tag) && !tag.schema_module ? [id] : [];
        });
        await noteWriter.create({
          id: captureId, title: deriveTitle(words), markdown: body, parent_id: landing.parentId,
          tagIds: [...(landing.tagId ? [landing.tagId] : []), ...textTagIds],
          attributes: [{ key: CAPTURED_ATTRIBUTE, value: "true" }],
        });
      }
    } catch (e) {
      // Nothing was created: keep the text so the user can retry (same ids).
      // A writer failure was already reported; writeErrors.report ignores it.
      writeErrors.report(e, addToast);
      setBusy(false);
      return;
    }
    attemptRef.current = null;
    setText("");
    setImages([]);
    setSkipped([]);
    uploadedRef.current.clear();
    setPicked(null);
    setSavedTo(madeTask ? t("Saved as a task") : t("Saved to {place}", { place: savedPlace }));
    setBusy(false);
    textareaRef.current?.focus();
    if (madeInboxTag) await onRefresh();
  }, [busy, destination, images, inboxNeedsConnection, landingFor, listening, noteCanHold, onRefresh, online, placeName, reading, stopListening, t, tags, text]);

  // Handwriting, a file or photo, a bookmark: the shared create entry makes the
  // note; in the inbox it then gets the tag and the flag like a typed capture.
  const kinds = useMemo(() => allKinds.filter((kind) => (KIND_IDS as readonly string[]).includes(kind.id)), [allKinds]);
  const createKind = async (kindId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const landing = await landingFor(destination, randomUUID());
      setOpen(false);
      const id = await create(kindId, { parentId: landing.parentId });
      if (id) {
        if (landing.tagId) await tagWriter.apply(id, landing.tagId);
        await propertyWriter.set(id, CAPTURED_ATTRIBUTE, "true");
      }
    } catch (e) {
      writeErrors.report(e, addToast);
    } finally {
      setBusy(false);
    }
  };

  const imagesWaitForConnection = images.length > 0 && !online;
  const close = () => { if (!busy) setOpen(false); };

  if (!open) return null;
  return (
    <>
      <Sheet label={t("Quick capture")} className="quick-capture-overlay" busy={busy} onClose={() => setOpen(false)} initialFocus={textareaRef} cardClassName="quick-capture-sheet" steady={choosing}>
        <SheetHeader title={t("Quick capture")} onClose={close} />

        {choosing ? (
          <div className="quick-capture-choosing">
            <CaptureWherePicker online={online} nodes={nodes} current={destination} journalOn={journalOn}
              onPick={(next) => { setPicked(next); setChoosing(false); }} onClose={() => setChoosing(false)} />
            <p className="quick-capture-hint">{t("Only for this capture. Change the usual place in Settings.")}</p>
            <div className="quick-capture-footer">
              <Button onClick={() => setChoosing(false)}>{t("Back")}</Button>
            </div>
          </div>
        ) : (
          <>
            <Pressable type="button" className="quick-capture-place" onClick={() => setChoosing(true)} disabled={busy}
              title={t("Choose where this one goes")}>
              {t("Goes to: {place}", { place: placeName })}
            </Pressable>

            <TextArea
              ref={textareaRef}
              className="quick-capture-textarea"
              value={text}
              onChange={(e) => { setText(e.target.value); if (savedTo) setSavedTo(null); }}
              onKeyDown={(e) => {
                // Keyboard-only capture: ⌘/Ctrl+↵ sends, Esc (ui/Modal) closes and keeps the
                // draft — so the whole flow (⌘⇧N → type → ⌘↵) never leaves the keyboard.
                if (isEnterKey(e) && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
              }}
              placeholder={t("What's on your mind?")}
              rows={5}
              disabled={busy}
            />

            {becomesTask && <p className="quick-capture-hint quick-capture-task" role="status">{t("Will be saved as a task: {title}", { title: reading.task!.title })}</p>}
            {savedTo && <p className="quick-capture-saved" role="status">{savedTo}</p>}

            {images.length > 0 && (
              <ul className="quick-capture-images" aria-label={t("Attached images")}>
                {images.map((file, index) => (
                  <AttachedImage
                    key={`${index}-${file.name}`}
                    file={file}
                    disabled={busy}
                    onRemove={() => setImages((current) => current.filter((f) => f !== file))}
                  />
                ))}
              </ul>
            )}
            {skipped.length > 0 && (
              <div className="quick-capture-hint quick-capture-skipped" role="status">
                <ImageOff size={14} />
                {t("Not attached (not an image Onden can store): {names}", { names: skipped.join("、") })}
              </div>
            )}

            <footer className="quick-capture-footer">
              <div className="quick-capture-kinds">
                {kinds.map((kind) => (
                  <Pressable key={kind.id} type="button" className="quick-capture-kind"
                    disabled={busy || (!online && kind.needsServer)}
                    title={!online && kind.needsServer ? t("Needs a connection") : t(kind.label)}
                    aria-label={t(kind.label)}
                    onClick={() => void createKind(kind.id)}>
                    <kind.Icon size={17} aria-hidden="true" />
                  </Pressable>
                ))}
                {speechAvailable && (
                  <Pressable
                    type="button"
                    className={`quick-capture-kind quick-capture-mic${listening ? " active" : ""}`}
                    onClick={() => listening ? stopListening() : startListening()}
                    disabled={busy}
                    aria-pressed={listening}
                    aria-label={listening ? t("Stop voice input") : t("Start voice input")}
                    title={listening ? t("Stop voice input") : t("Start voice input")}
                  >
                    {listening ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
                  </Pressable>
                )}
              </div>
              <Pressable type="button" className="quick-capture-more" onClick={() => { setOpen(false); onMore(); }} disabled={busy}>{t("More…")}</Pressable>
              <Pressable
                type="button"
                className="quick-capture-save"
                onClick={() => void send()}
                disabled={(!text.trim() && images.length === 0) || busy || imagesWaitForConnection}
              >
                {busy ? t("Saving…") : t("Save")}
              </Pressable>
            </footer>
            {imagesWaitForConnection && (
              <div className="quick-capture-hint quick-capture-images-offline" role="status">
                {t("Images need a connection to upload. Connect, then save — or remove the images.")}
              </div>
            )}
            {online ? (
              hasKeyboard && <div className="quick-capture-hint quick-capture-hint--kbd">
                <kbd>{formatChord("$mod+enter")}</kbd> {t("Save")} · <kbd>esc</kbd> {text.trim() ? t("Close, keep the draft") : t("Close")}
              </div>
            ) : (
              // Offline captures are queued and replay on reconnect — no longer a
              // dead-end. The hint reassures AND, once writes are actually
              // queued, names the concrete count so the capture is verifiably
              // safe (not just a promise).
              <div className="quick-capture-hint">
                {inboxNeedsConnection ? t("Connect once to set up the inbox. Your text is kept.") : t("Offline — saved locally, will sync on reconnect.")}
                {pendingWrites > 0 && (
                  <span className="quick-capture-pending">{t("{n} change(s) waiting to sync", { n: pendingWrites })}</span>
                )}
              </div>
            )}
          </>
        )}
      </Sheet>
    </>
  );
}
