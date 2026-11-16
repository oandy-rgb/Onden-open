import { Suspense, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import type { EditorView } from "@codemirror/view";
import { GripVertical, Hash } from "lucide-react";
import { isTagNameShape } from "@onden/markdown/contract";
import { lazyWithReload } from "../lib/lazyWithReload";
import type { HandToAi } from "../hooks/useHandToAi";
import { addToast } from "../lib/appStore";
import { copyBlockLink, insertBlockTag, insertBlockTags, newTagName, paragraphTagChoices, paragraphTextAt } from "../lib/editorParagraphActions";
import { clearParagraphFrame, flashParagraph, frameParagraph, frameRange, paragraphRangeAt, type ParagraphRange } from "../lib/editorParagraphFrame";
import type { TagItem } from "../lib/editorCompletion";
import { useT } from "../lib/i18n";
import { isEnterKey } from "../lib/keys";
import { containsTitle } from "../lib/noteSearch";
import { usePersistedFlag, PREFS } from "../lib/prefs";
import { rememberBlockFunction, usedBlockFunctions, type BlockFunction } from "../lib/tagFunctions";
import { PARAGRAPH_TOOLS, SELECTION_TOOLS, toolLabel } from "../lib/toolbarLayout";
import { tagQuery } from "../lib/hashtags";
import type { BlockChildEntries } from "../hooks/useBlockChildNote";
import EmptyState from "./EmptyState";
import { exampleOf } from "./functionCatalog";
import "./paragraphTools";
import { openToolbarEditor } from "../lib/toolbarEditorRequest";
import { Button, keepFocus, Menu, MenuItem, MenuSeparator, Popover, SearchField, Pressable, usePopover, type PopoverPlacement, type PopoverState } from "./ui";
import type { ToolSpecs } from "./ToolbarRow";
import { TOOL_ICONS } from "./toolbarIcons";
import "./ParagraphMenu.css";

const HandToAiMenu = lazyWithReload(() => import("./HandToAiMenu"));

// "Things you do to this paragraph", from ONE list of actions (PARAGRAPH_TOOLS):
// 加標籤 (what the paragraph becomes: a function or a tag), 交給 AI, 複製段落連結,
// 這段的歷史, 變成子筆記 (and, where they apply, 把核取方塊轉成任務, 展開回內文).
// The phone bar, the selection bar and the desktop handle's menu all draw that
// list (`tools`), so none has a second copy; there is no 「這段」 menu of its own.
//
// A button that opens a panel (加標籤, 交給 AI) or a sheet (the history) remembers
// the paragraph when it is pressed and frames it while that is open
// (lib/editorParagraphFrame); everything the panel does acts on that paragraph,
// never on wherever the caret has gone since. A button that just acts (copy the
// link, turn into a child note) flashes the paragraph and says what happened.
// A panel opens on the side of the control that opened it: above the phone bar,
// below the bubble or the handle. The editor does the writing
// (lib/editorParagraphActions); these only ask which paragraph and show the choices.

/** What else the paragraph at the selection's start offers, asked when a button is drawn or pressed
 *  (it depends on where the caret is). */
export type ParagraphExtras = {
  onConvertTask?: () => void;
  /** Open 「這段的歷史」 for the paragraph. */
  onBlockHistory?: () => void;
  /** 「變成子筆記」 on a paragraph (on a selection: the selected words), 「展開回內文」 on a `![[child]]` line. */
  blockChild?: BlockChildEntries;
};

export type ParagraphMenuProps = {
  getView: () => EditorView | null;
  /** The note's title, for the block link. Without it there is no "Copy block link". */
  noteTitle?: string;
  
  tags: readonly TagItem[];
  /** The catalog's functions a paragraph can take (lib/tagFunctions blockFunctions): 「試試功能」. */
  functions: readonly BlockFunction[];
  /** `span`: the selected text, when the paragraphs are the ones a selection touches. */
  extrasAt: (from: number, span?: ParagraphSpan) => ParagraphExtras;
  /** 「交給 AI」 (hooks/useHandToAi). Absent: no such button. */
  handToAi?: HandToAi;
  /** The note can't be changed: only what reads the paragraph is offered. */
  readOnly?: boolean;
  /** A menu or panel is open: the editor keeps its bar up while focus is in it. */
  onOpenChange?: (open: boolean) => void;
  /** Turn a function on (asking once where the module needs the owner's yes) and give the
   *  name of its tag; null when it stayed off. Left out where this person can't decide. */
  onImportModuleTag?: (moduleId: string, name: string) => Promise<string | null>;
};

export type ParagraphSpan = { from: number; to: number };

/** Copy `[[title/first words]]` for the paragraph at a position (pasting it into Onden binds it to the paragraph,
 *  lib/blockSafety), flash the paragraph and say what happened. */
export function useCopyBlockLink(getView: () => EditorView | null, noteTitle?: string): (pos: number) => void {
  const t = useT();
  return (pos) => {
    const view = getView();
    if (!view || !noteTitle) return;
    const range = paragraphRangeAt(view, pos);
    if (range) flashParagraph(view, range);
    void copyBlockLink(view, pos, noteTitle).then((result) => {
      if (!result) addToast(t("This paragraph can't take a block link"), "error");
      else if (result.copied) addToast(t("Link copied · paste it into any note"), "success");
      // The clipboard refused: show the text so it can be copied by hand.
      else addToast(t("Couldn't copy — copy the link yourself: {link}", { link: result.link }), "error");
    });
  };
}

/** What a caller can ask of the desktop handle's menu. */
export type ParagraphHandleControl = { open: (pos: number) => void };

type Panel = "menu" | "tag" | "ai";
/** Which paragraph a button works on: `at` (the handle's paragraph, the caret is put there first),
 *  `span` (a selection: the paragraphs it touches), else the one the caret is in. */
export type ParagraphTarget = { at?: number; span?: ParagraphSpan };
type ToolId = typeof PARAGRAPH_TOOLS[number];
type Session = { panel: Panel; range: ParagraphRange; target: ParagraphTarget; placement: PopoverPlacement; aiText: string };

const labelOf = (id: ToolId) => toolLabel(SELECTION_TOOLS.find((tool) => tool.id === id)!);

/** The panels and one-press actions for a paragraph, opened from any button: `open(panel, anchor)` puts
 *  the panel next to `anchor` (the button pressed, or 「更多」 when the button is tucked away there).
 *  Render `nodes` once, anywhere. */
export function useParagraphPanels({ getView, noteTitle, tags, functions, extrasAt, handToAi, onOpenChange, readOnly, onImportModuleTag }: ParagraphMenuProps) {
  const t = useT();
  const [session, setSession] = useState<Session | null>(null);
  const viewOf = useRef(getView);
  viewOf.current = getView;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const close = () => {
    const view = viewOf.current();
    if (view) clearParagraphFrame(view);
    setSession(null);
  };
  const pop = usePopover<HTMLElement>({ open: session !== null, onClose: close, placement: session?.placement });
  const copyLink = useCopyBlockLink(getView, noteTitle);
  const open = session !== null;
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  useEffect(() => {
    notify.current?.(open);
    return () => notify.current?.(false);
  }, [open]);
  // Closing the editor under an open panel takes its frame along.
  useEffect(() => () => { const view = viewOf.current(); if (view?.dom.isConnected) clearParagraphFrame(view); }, []);

  const notAParagraph = () => addToast(t("Put the cursor in a paragraph first"), "error");
  /** The position a button works from, and the paragraph(s) there; the handle puts the caret on its own paragraph first. */
  const resolve = (view: EditorView, target: ParagraphTarget) => {
    if (target.at !== undefined) view.dispatch({ selection: { anchor: target.at } });
    const pos = target.span?.from ?? view.state.selection.main.head;
    return { pos, range: target.span ? paragraphRangeAt(view, target.span.from, target.span.to) : paragraphRangeAt(view, pos) };
  };

  const begin = (panel: Panel, anchor: HTMLElement | null, target: ParagraphTarget = {}, placement: PopoverPlacement = "top-start") => {
    const view = getView();
    if (!view) return;
    const { pos, range } = resolve(view, target);
    if (!range) { notAParagraph(); return; }
    // What the AI works on and its answer replaces: the selected words, or the paragraph's.
    const aiText = target.span ? view.state.doc.sliceString(target.span.from, target.span.to) : paragraphTextAt(view, pos) ?? "";
    frameParagraph(view, range);
    pop.anchor.current = anchor;
    if (panel === "ai") void handToAi?.load();
    setSession({ panel, range, target, placement, aiText });
  };
  /** Switch the open panel to another, on the paragraph it already has. */
  const switchTo = (panel: Panel) => {
    if (session && panel === "ai") void handToAi?.load();
    if (session) setSession({ ...session, panel });
  };

  const instant = (id: Exclude<ToolId, "tag" | "ai">, target: ParagraphTarget) => {
    const view = getView();
    if (!view) return;
    const { pos, range } = resolve(view, target);
    if (!range) { notAParagraph(); return; }
    const extras = extrasAt(pos, target.span);
    if (id === "copyLink") copyLink(pos);
    else if (id === "history") extras.onBlockHistory?.();
    else if (id === "toChild") {
      const move = extras.blockChild?.move;
      if (!move) { addToast(t("This part can't be moved into a child note."), "error"); return; }
      if (move.disabled) { addToast(move.disabled, "error"); return; }
      flashParagraph(view, range);
      move.run();
    } else if (id === "convertTask") extras.onConvertTask?.();
    else extras.blockChild?.expand?.run();
  };
  const act = (id: ToolId, anchor: HTMLElement | null, target: ParagraphTarget, placement?: PopoverPlacement) => {
    if (id === "tag" || id === "ai") begin(id, anchor, target, placement);
    else instant(id, target);
  };

  /** The actions as toolbar buttons for the paragraph `target` names, panels opening on the side `placement` names.
   *  Only what applies is there; with the caret outside a paragraph (code, a table, a blank line) the buttons are
   *  disabled, the reason as their tooltip. */
  const tools = (target: ParagraphTarget = {}, placement?: PopoverPlacement): ToolSpecs => {
    const view = getView();
    if (!view) return {};
    const pos = target.span?.from ?? target.at ?? view.state.selection.main.head;
    const hasParagraph = (target.span ? paragraphRangeAt(view, target.span.from, target.span.to) : paragraphRangeAt(view, pos)) !== null;
    const extras = extrasAt(pos, target.span);
    const disabled = hasParagraph ? undefined : t("Put the cursor in a paragraph first");
    const spec = (id: ToolId, opensPanel = false) => ({ run: (anchor: HTMLElement | null) => act(id, anchor, target, placement), opensPanel, disabled });
    const writes = !readOnly;
    const move = extras.blockChild?.move;
    return {
      ...(writes ? { tag: spec("tag", true) } : {}),
      ...(writes && handToAi?.entry.shown ? { ai: spec("ai", true) } : {}),
      ...(writes && noteTitle ? { copyLink: spec("copyLink") } : {}),
      ...(extras.onBlockHistory ? { history: spec("history") } : {}),
      ...(writes && !extras.blockChild?.expand ? { toChild: { ...spec("toChild"), disabled: disabled ?? move?.disabled ?? (move ? undefined : t("This part can't be moved into a child note.")) } } : {}),
      ...(writes && extras.onConvertTask ? { convertTask: spec("convertTask") } : {}),
      ...(writes && extras.blockChild?.expand ? { expand: { ...spec("expand"), disabled: extras.blockChild.expand.disabled } } : {}),
    };
  };

  /** Put the tag `name` on the remembered paragraph(s): where the frame is now, not where the caret is. */
  const applyTag = (name: string) => {
    const view = getView();
    const current = sessionRef.current;
    if (!view || !current) return;
    const framed = frameRange(view) ?? current.range;
    // A tag named before the name rule can hold symbols a paragraph's `{…}` cannot: say so instead of doing nothing.
    if (!isTagNameShape(name)) { addToast(t("This tag's name has symbols a paragraph tag can't hold. Rename the tag first."), "info"); close(); return; }
    if (current.target.span) insertBlockTags(view, framed.from, framed.to, name);
    else insertBlockTag(view, framed.from, name);
    close();
    view.focus();
  };

  const writesNow = !readOnly;
  const nodes: ReactNode = (
    <>
      {session?.panel === "menu" && (
        <Menu popover={pop} label={t("This paragraph")}>
          {PARAGRAPH_TOOLS.map((id) => {
            const spec = tools(session.target, session.placement)[id];
            if (!spec) return null;
            const Icon = TOOL_ICONS[id]!;
            return (
              <MenuItem key={id} keepOpen={spec.opensPanel} disabled={!!spec.disabled} onSelect={() => {
                if (spec.opensPanel) { switchTo(id as "tag" | "ai"); return; }
                const target = session.target;
                close();
                instant(id as Exclude<ToolId, "tag" | "ai">, target);
              }}>
                <Icon size={16} />{t(labelOf(id))}
                {typeof spec.disabled === "string" && <span className="paragraph-menu-hint">{spec.disabled}</span>}
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <MenuItem onSelect={() => { close(); openToolbarEditor(); }}>{t("Edit the toolbar…")}</MenuItem>
        </Menu>
      )}
      {writesNow && session?.panel === "tag" && <TagPicker popover={pop} tags={tags} functions={functions} onPick={applyTag} onImportModuleTag={onImportModuleTag} />}
      {writesNow && session?.panel === "ai" && handToAi && (
        <Suspense fallback={null}>
          <HandToAiMenu popover={pop} hand={handToAi} text={session.aiText}
            at={{ x: pop.anchor.current?.getBoundingClientRect().left ?? 8, y: (pop.anchor.current?.getBoundingClientRect().bottom ?? 8) + 8 }}
            label={session.target.span ? t("Selected text") : t("This paragraph")} />
        </Suspense>
      )}
    </>
  );
  return { open: begin, close, isOpen: open, nodes, tools };
}

/** The handle at the left of a paragraph. Its menu is the same action list as the toolbars', for the
 *  paragraph starting at `pos`; `control.open` opens it from the keyboard. */
export function ParagraphHandleButton({ pos: handlePos, top, left, control, ...props }: ParagraphMenuProps & {
  /** The paragraph it stands beside, read when it is clicked; null when there is none any more. */
  pos: () => number | null;
  top: number;
  left: number;
  control: Ref<ParagraphHandleControl>;
}) {
  const t = useT();
  const panels = useParagraphPanels(props);
  const button = useRef<HTMLButtonElement>(null);
  const placement = "bottom-start";
  useImperativeHandle(control, () => ({ open: (at) => panels.open("menu", button.current, { at }, placement) }));
  return (
    <>
      <Pressable
        type="button"
        ref={button}
        className="md-paragraph-handle"
        style={{ "--handle-top": `${top}px`, "--handle-left": `${left}px` } as CSSProperties}
        title={t("This paragraph")}
        aria-label={t("This paragraph")}
        aria-haspopup="menu"
        aria-expanded={panels.isOpen}
        onMouseDown={keepFocus}
        onClick={(e) => {
          if (panels.isOpen) return panels.close();
          const at = handlePos();
          if (at !== null) panels.open("menu", e.currentTarget, { at }, placement);
        }}
      >
        <GripVertical size={16} />
      </Pressable>
      {panels.nodes}
    </>
  );
}

/** The panel's one text field. An input method's composition never sends or filters: the typed text
 *  is shown as it comes, the query follows once the composition ends. */
function usePanelQuery() {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const composing = useRef(false);
  return {
    typed, query, composing,
    onChange: (value: string) => { setTyped(value); if (!composing.current) setQuery(value); },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (value: string) => { composing.current = false; setQuery(value); },
  };
}

/** 加標籤: what this paragraph becomes. 「試試功能」 (the catalog's functions: choosing an on one
 *  applies it now; an off one first shows its example and asks) and 「你的標籤」 (only the person's own
 *  tags — a function's tag and the system's are never listed by name), filtered together by what is
 *  typed; a name that matches nothing offers to make that tag. Enter takes the first row. */
export function TagPicker({ popover, tags, functions, onPick, onImportModuleTag }: {
  popover: PopoverState<HTMLElement>;
  tags: readonly TagItem[];
  functions: readonly BlockFunction[];
  /** Put the tag called `name` on the paragraph. */
  onPick: (name: string) => void;
  onImportModuleTag?: (moduleId: string, name: string) => Promise<string | null>;
}) {
  const t = useT();
  const input = usePanelQuery();
  const [preview, setPreview] = useState<BlockFunction | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = usePersistedFlag(PREFS.paragraphFunctionsHidden, false);
  const used = usedBlockFunctions();

  const wanted = tagQuery(input.query).toLowerCase();
  const matching = [...functions]
    .sort((a, b) => Number(used.includes(a.fn.id)) - Number(used.includes(b.fn.id)))
    .filter((row) => !wanted || containsTitle(wanted, row.title) !== null || containsTitle(wanted, row.description) !== null);
  const shownFunctions = hidden && !wanted ? [] : matching;
  const own = paragraphTagChoices(tags.filter((tag) => tag.kind === "own"), wanted);
  const created = newTagName(tags, input.query);

  const apply = (row: BlockFunction, name: string) => { rememberBlockFunction(row.fn.id); onPick(name); };
  const turnOn = async (row: BlockFunction) => {
    if (!onImportModuleTag || busy) return;
    setBusy(true);
    const name = await onImportModuleTag(row.fn.module ?? row.fn.id, row.tagName);
    setBusy(false);
    if (name) apply(row, name);
  };
  const primary = shownFunctions.find((row) => !row.off) ?? null;
  const primaryTag = primary ? null : own.find((tag) => tag.name.toLowerCase() === wanted)?.name ?? own[0]?.name ?? created;
  const focusList = () => popover.popup.current?.querySelector<HTMLElement>(".paragraph-panel-list button")?.focus();

  if (preview) {
    const example = exampleOf(preview.fn);
    return (
      <Popover popover={popover} label={preview.title}>
        <div className="paragraph-panel">
          <div className="paragraph-example-title"><preview.Icon size={16} aria-hidden="true" />{preview.title}<span className="paragraph-fn-off">{t("Not on yet")}</span></div>
          {example && <p className="paragraph-example-text">{t(example.result)}</p>}
          {example && (
            <div className="paragraph-example-sample" aria-hidden="true">
              <span className="paragraph-example-sample-title">{t(example.sampleTitle)}</span>
              <span className="paragraph-fn-desc">{t(example.sampleDetail)}</span>
            </div>
          )}
          <div className="paragraph-example-actions">
            <Button onClick={() => setPreview(null)}>{t("Not now")}</Button>
            {preview.canTurnOn && onImportModuleTag && <Button variant="primary" disabled={busy} onClick={() => void turnOn(preview)}>{t("Turn on and apply")}</Button>}
          </div>
        </div>
      </Popover>
    );
  }
  return (
    <Popover popover={popover} label={t("Tag this paragraph")}>
      <div className="paragraph-panel">
        <SearchField autoFocus enterKeyHint="done" value={input.typed}
          label={t("Search tags or functions…")}
          onValueChange={input.onChange}
          onCompositionStart={input.onCompositionStart}
          onCompositionEnd={(e) => input.onCompositionEnd(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (isEnterKey(e) && !input.composing.current) {
              e.preventDefault();
              if (primary) apply(primary, primary.tagName);
              else if (primaryTag) onPick(primaryTag);
            }
            if (e.key === "ArrowDown") { e.preventDefault(); focusList(); }
          }} />
        <div className="paragraph-panel-list">
          {shownFunctions.length > 0 && <div className="paragraph-panel-heading">{t("Try a function")}</div>}
          {shownFunctions.map((row) => (
            <MenuItem key={row.fn.id} className="paragraph-fn-row" keepOpen onSelect={() => (row.off ? setPreview(row) : apply(row, row.tagName))}>
              <row.Icon size={18} aria-hidden="true" />
              <span className="paragraph-fn-text">
                <span>{row.title}{row.off && <span className="paragraph-fn-off">{t("Not on yet")}</span>}</span>
                <span className="paragraph-fn-desc">{row.description}</span>
              </span>
            </MenuItem>
          ))}
          {matching.length > 0 && !wanted && (
            <Button variant="ghost" size="sm" className="paragraph-panel-quiet" onClick={() => setHidden(!hidden)}>
              {hidden ? t("Show functions again") : t("Don't suggest functions")}
            </Button>
          )}
          {(own.length > 0 || created) && <div className="paragraph-panel-heading">{t("Your tags")}</div>}
          {own.map((tag) => (
            <MenuItem key={tag.id} className="paragraph-tag-row" keepOpen onSelect={() => onPick(tag.name)}>
              <span className="tag-color-dot" style={tag.color ? ({ "--dot-color": tag.color } as CSSProperties) : undefined} />
              {tag.name}
            </MenuItem>
          ))}
          {created && (
            <MenuItem className="paragraph-tag-row" keepOpen onSelect={() => onPick(created)}>
              <Hash size={14} />{t("Create tag “{name}”", { name: created })}
            </MenuItem>
          )}
          {shownFunctions.length === 0 && own.length === 0 && !created && <EmptyState size="inline" variant="noResults" as="div" title={t("No match")} />}
        </div>
      </div>
    </Popover>
  );
}
