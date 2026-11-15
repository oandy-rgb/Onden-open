import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type Decision, labelFor, type Place } from "./aiSuggestions";

// An AI's pending places in the note, drawn like tracked changes: the paragraph
// it would replace or remove is struck through, what it would put there is
// shown below with a "＋" and a bar (not colour alone), and each place has its
// own Accept and Reject. The note's text is never changed by this; the places
// are drawn from outside and the buttons call back into the host, which
// decides on the server (lib/aiSuggestions.ts).
//
// The host computes the places from the note's text and pushes them with
// setSuggestionPlaces; between pushes a typed edit moves each place with its
// text, so a widget never lands in the middle of other text.

export type SuggestionHost = { onDecide(place: Place, decision: Decision): void };

export const setSuggestionPlaces = StateEffect.define<Place[]>();

class PlaceWidget extends WidgetType {
  constructor(readonly place: Place, readonly host: SuggestionHost) { super(); }

  eq(other: PlaceWidget) { return JSON.stringify(other.place) === JSON.stringify(this.place); }
  get estimatedHeight() { return 72; }
  // A tap on a button is not a tap in the text.
  ignoreEvent() { return true; }

  toDOM() {
    const { place } = this;
    const comment = place.kind === "comment";
    const el = document.createElement("div");
    el.className = `cm-ai-place cm-ai-place--${place.kind}`;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", comment ? labelFor.commentBadge(place.agentName) : labelFor.badge(place.agentName));
    // Not selectable text of the note: the caret never lands in a suggestion.
    el.contentEditable = "false";

    const head = document.createElement("div");
    head.className = "cm-ai-place-head";
    const badge = document.createElement("span");
    badge.className = "cm-ai-who";
    badge.textContent = comment ? labelFor.commentBadge(place.agentName) : labelFor.badge(place.agentName);
    head.append(badge);
    if (place.older) {
      const older = document.createElement("span");
      older.className = "cm-ai-older";
      older.textContent = labelFor.older();
      head.append(older);
    }
    el.append(head);

    if (place.kind === "delete" || place.spacingOnly || place.indentOnly) {
      const hint = document.createElement("div");
      hint.className = "cm-ai-hint";
      hint.textContent = place.spacingOnly ? labelFor.spacingHint() : place.indentOnly ? labelFor.indentHint() : labelFor.deleteHint();
      el.append(hint);
    } else if (place.newText !== null) {
      const body = document.createElement("div");
      body.className = comment ? "cm-ai-comment-text" : "cm-ai-add";
      if (!comment) {
        const sign = document.createElement("span");
        sign.className = "cm-ai-sign";
        sign.setAttribute("aria-hidden", "true");
        sign.textContent = "＋";
        body.append(sign);
      }
      const text = document.createElement("div");
      text.className = "cm-ai-text";
      text.textContent = place.newText;
      body.append(text);
      el.append(body);
    }

    const actions = document.createElement("div");
    actions.className = "cm-ai-actions";
    const button = (decision: Decision, label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `cm-ai-btn cm-ai-btn--${decision}`;
      b.textContent = label;
      b.disabled = !place.canAct || place.busy;
      if (place.busy) b.setAttribute("aria-busy", "true");
      if (!place.canAct) b.title = labelFor.offline();
      // Keep the editor's focus (and the phone's keyboard) where it is.
      b.addEventListener("pointerdown", (event) => event.preventDefault());
      b.addEventListener("click", () => this.host.onDecide(this.place, decision));
      return b;
    };
    actions.append(button("accept", comment ? labelFor.markRead() : labelFor.accept()), button("reject", comment ? labelFor.dismiss() : labelFor.reject()));
    el.append(actions);
    return el;
  }
}

const struck = Decoration.mark({ class: "cm-ai-del" });

function build(places: readonly Place[], docLength: number, host: SuggestionHost): DecorationSet {
  const ranges = places.flatMap((place) => {
    const at = Math.min(place.at, docLength);
    const out = [Decoration.widget({ widget: new PlaceWidget(place, host), block: true, side: 1 }).range(at)];
    const from = Math.min(place.from, docLength);
    const to = Math.min(place.to, docLength);
    if ((place.kind === "replace" || place.kind === "delete") && !place.spacingOnly && to > from) out.push(struck.range(from, to));
    return out;
  });
  return Decoration.set(ranges, true);
}

/** The pending places of an AI. `host` is stable for the editor's life. */
export function suggestionPlacesExtension(host: SuggestionHost): Extension {
  return StateField.define<{ places: Place[]; decorations: DecorationSet }>({
    create: () => ({ places: [], decorations: Decoration.none }),
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setSuggestionPlaces)) {
          // The host may compute places from text the editor has not received
          // yet: keep them inside this doc, or the next change's mapPos throws.
          const length = tr.state.doc.length;
          const places = effect.value.map((p) => ({ ...p, from: Math.min(p.from, length), to: Math.min(p.to, length), at: Math.min(p.at, length) }));
          return { places, decorations: build(places, length, host) };
        }
      }
      if (!tr.docChanged) return value;
      const before = tr.startState.doc.length;
      const places = value.places.map((p) => ({
        ...p,
        from: tr.changes.mapPos(Math.min(p.from, before), 1),
        to: tr.changes.mapPos(Math.min(p.to, before), -1),
        at: tr.changes.mapPos(Math.min(p.at, before), 1),
      }));
      return { places, decorations: build(places, tr.state.doc.length, host) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });
}
