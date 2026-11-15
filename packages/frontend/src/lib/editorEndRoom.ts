import { Facet, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";

// 寫到底不黏底: room under the last line, so the line being written can rise
// off the bottom edge of the screen instead of sitting on it.
//
// CodeMirror's own `scrollPastEnd()` pads by the height of its scroller, and
// the note editor's scroller has `overflow: visible` (the page scrolls, not the
// editor), so that would pad by the whole note. This is the same idea sized in
// px by the host: an empty block after the text, plus a scroll margin that
// applies only while the caret is within `px` of the end.
//
// The room appears only when it is needed: the last line's bottom, in screen
// coordinates, is within `px` of `bottomEdge()` (the visible bottom; the mobile
// keyboard shrinks it). Focusing a short note therefore never moves anything
// under it. It is re-judged on content, geometry, selection and focus changes,
// and once it has appeared it stays for as long as this extension is installed
// (the host installs it while writing), so typing does not make it blink.
// The scroll margin the room needs is endRoomMargin; lib/editorKeyboard combines it with the bar's.
//
// Taking the room away moves everything below the note up. `collapseEndRoom`
// holds that back while a pointer is down (the tap that blurred the editor), so
// what the person pressed is still under their finger when they let go.
//
//   compartment.of(endRoom(160, visibleBottom));  compartment.reconfigure(endRoom(160, visibleBottom))
//   collapseEndRoom(view, () => compartment.reconfigure([]));

const setRoomOn = StateEffect.define<boolean>();
interface RoomConfig { readonly px: number; readonly bottomEdge: () => number }
const roomConfig = Facet.define<RoomConfig, RoomConfig | null>({ combine: (v) => v[0] ?? null });
// Module-level on purpose: while the host only changes `px` (keyboard opening) the same
// field and watcher stay installed, so the room already out does not blink away and back.
const roomOn = StateField.define<boolean>({
  create: () => false,
  update: (on, tr) => { for (const e of tr.effects) if (e.is(setRoomOn)) return e.value; return on; },
});

class Room extends WidgetType {
  constructor(private readonly px: number) { super(); }
  eq(other: Room) { return other.px === this.px; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-end-room";
    el.style.height = `${this.px}px`;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  get estimatedHeight() { return this.px; }
}

/** Judges whether the room is needed, and holds back its removal while a pointer is down. */
class RoomWatcher {
  private pointerDown = false;
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly down = () => { this.pointerDown = true; };
  private readonly up = () => {
    this.pointerDown = false;
    if (!this.release) return;
    const run = this.release;
    this.release = null;
    this.timer = setTimeout(run, 0); // after the click this press produces
  };
  constructor(private readonly view: EditorView) {
    window.addEventListener("pointerdown", this.down, true);
    window.addEventListener("pointerup", this.up, true);
    window.addEventListener("pointercancel", this.up, true);
    this.judge();
  }
  update(u: ViewUpdate) {
    if (u.docChanged || u.geometryChanged || u.viewportChanged || u.selectionSet || u.focusChanged
      || u.startState.facet(roomConfig) !== u.state.facet(roomConfig)) this.judge();
  }
  judge() {
    if (this.view.state.field(roomOn)) return;
    this.view.requestMeasure({
      key: this,
      read: (v) => {
        const cfg = v.state.facet(roomConfig);
        return !!cfg && cfg.bottomEdge() - (v.documentTop + v.lineBlockAt(v.state.doc.length).bottom) <= cfg.px;
      },
      // A measure's write phase may not dispatch; the microtask still runs before the frame is painted.
      write: (needed, v) => {
        if (needed) queueMicrotask(() => { if (v.state.field(roomOn, false) === false) v.dispatch({ effects: setRoomOn.of(true) }); });
      },
    });
  }
  collapse(run: () => void) {
    if (this.pointerDown) this.release = run; else run();
  }
  destroy() {
    window.removeEventListener("pointerdown", this.down, true);
    window.removeEventListener("pointerup", this.up, true);
    window.removeEventListener("pointercancel", this.up, true);
    clearTimeout(this.timer);
    this.release = null;
  }
}

const watcher = ViewPlugin.fromClass(RoomWatcher);

/** The scroll margin the room asks for: `px` while the caret is within `px` of the end of the text, else 0.
 *  lib/editorKeyboard folds it into the editor's one scrollMargins. */
export function endRoomMargin(view: EditorView): number {
  const cfg = view.state.facet(roomConfig);
  if (!cfg) return 0;
  const block = view.lineBlockAt(view.state.selection.main.head);
  // contentHeight counts the room block only while it is there.
  const textEnd = view.contentHeight - (view.state.field(roomOn, false) ? cfg.px : 0);
  return textEnd - block.bottom <= cfg.px ? cfg.px : 0;
}

export function endRoom(px: number, bottomEdge: () => number): Extension {
  if (px <= 0) return [];
  return [
    roomConfig.of({ px, bottomEdge }),
    roomOn,
    watcher,
    EditorView.decorations.compute([roomOn, "doc", roomConfig], (state) => {
      const cfg = state.facet(roomConfig);
      return cfg && state.field(roomOn)
        ? RangeSet.of([Decoration.widget({ widget: new Room(cfg.px), block: true, side: 1 }).range(state.doc.length)])
        : Decoration.none;
    }),
  ];
}

/** Run `run` (which removes the room) now, or after the pointer that is down is released. */
export function collapseEndRoom(view: EditorView, run: () => void) {
  const plugin = view.plugin(watcher);
  if (plugin) plugin.collapse(run); else run();
}
