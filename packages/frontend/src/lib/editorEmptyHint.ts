import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { observeSize } from "./observeSize";

// The empty-note hint 「開始書寫…」, drawn OUTSIDE the editable content.
//
// CodeMirror's own placeholder() is a widget inside the first .cm-line. On an
// Android phone (Chrome WebView, Gboard) that widget is part of the
// contenteditable: the native caret was drawn after it (#400 took away its
// inline space), and the touch-selection UI still treated it as content and
// showed two handles spanning the hint. Here the hint is a plain element in
// view.scrollDOM — a sibling of contentDOM, like CodeMirror's cursor and
// selection layers — laid over the first line. contentDOM then holds only the
// empty line, so there is nothing for a tap or a long press to select. Screen
// readers get the text from aria-placeholder on contentDOM, as with
// CodeMirror's placeholder().

export const EMPTY_HINT_CLASS = "cm-emptyHint";

/** The font properties the hint copies from the first line, so it looks the
 *  same as the text that replaces it even when app CSS restyles .cm-content
 *  (zen mode, the note document's font size). */
const FONT_PROPS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"] as const;

interface HintBox { left: number; top: number; width: number; font: Partial<Record<(typeof FONT_PROPS)[number], string>> }

class EmptyHint implements PluginValue {
  readonly dom: HTMLElement;
  composing = false;
  /** App CSS can restyle .cm-content (zen mode's font size, the note
   *  document's padding) without CodeMirror seeing a geometry change, e.g.
   *  while the scroller's min-height keeps the editor the same size. The
   *  content box resizes then, so watch it and follow. */
  private readonly stopResize: () => void;
  private readonly measure = {
    key: this,
    read: (view: EditorView): HintBox | null => {
      const line = view.contentDOM.querySelector<HTMLElement>(".cm-line");
      if (!line) return null;
      const base = view.scrollDOM.getBoundingClientRect();
      const box = line.getBoundingClientRect();
      const style = getComputedStyle(line);
      const font: HintBox["font"] = {};
      for (const p of FONT_PROPS) font[p] = style[p];
      const sx = view.scaleX || 1, sy = view.scaleY || 1;
      return {
        left: (box.left - base.left) / sx + view.scrollDOM.scrollLeft + (parseFloat(style.paddingLeft) || 0),
        top: (box.top - base.top) / sy + view.scrollDOM.scrollTop + (parseFloat(style.paddingTop) || 0),
        width: Math.max(0, box.width / sx - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)),
        font,
      };
    },
    write: (box: HintBox | null) => {
      if (!box) return;
      const s = this.dom.style;
      s.left = `${box.left}px`; s.top = `${box.top}px`; s.width = `${box.width}px`;
      Object.assign(s, box.font);
    },
  };

  constructor(readonly view: EditorView, text: string) {
    const dom = document.createElement("div");
    dom.className = EMPTY_HINT_CLASS;
    dom.setAttribute("aria-hidden", "true");
    dom.textContent = text;
    this.dom = dom;
    view.scrollDOM.appendChild(dom);
    this.stopResize = observeSize(view.contentDOM, () => this.sync());
    this.sync();
  }

  get visible() { return this.view.state.doc.length === 0 && !this.composing; }

  sync() {
    const show = this.visible;
    this.dom.style.display = show ? "" : "none";
    if (show) this.view.requestMeasure(this.measure);
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.geometryChanged || u.viewportChanged || u.focusChanged) this.sync();
  }

  destroy() { this.stopResize(); this.dom.remove(); }
}

/** Shows `text` over the first line while the document is empty, and hides it
 *  the moment anything arrives — an IME composition included (compositionstart
 *  fires before the first character lands in the doc). */
export function emptyDocHint(text: string): Extension {
  if (!text) return [];
  return [
    ViewPlugin.define((view) => new EmptyHint(view, text), {
      eventHandlers: {
        compositionstart() { this.composing = true; this.sync(); },
        compositionend() { this.composing = false; this.sync(); },
      },
    }),
    EditorView.contentAttributes.of({ "aria-placeholder": text }),
    EditorView.theme({
      [`.${EMPTY_HINT_CLASS}`]: {
        position: "absolute", pointerEvents: "none", userSelect: "none",
        color: "var(--ac-muted)", fontStyle: "italic",
        whiteSpace: "pre-wrap", overflowWrap: "anywhere", boxSizing: "border-box",
      },
    }),
  ];
}
