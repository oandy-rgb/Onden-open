import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { MentionAction, MentionCard } from "./agentMentions";

// What sits under an `@ai` mention in the editor: whether it was sent and how
// it is going (lib/agentMentions.ts words it). The note's text is never
// changed by this — the card is drawn from outside, below the mention's block,
// and the buttons call back into the host, which does the sending.
//
// The host computes the cards from the note's text and pushes them with
// setMentionCards; between pushes a typed edit moves each card with its
// mention, so a card never lands in the middle of other text.

export type MentionCardHost = { onAction(key: string, action: MentionAction): void };

export const setMentionCards = StateEffect.define<MentionCard[]>();

class CardWidget extends WidgetType {
  constructor(readonly card: MentionCard, readonly host: MentionCardHost) { super(); }

  eq(other: CardWidget) { return JSON.stringify(other.card) === JSON.stringify(this.card); }
  get estimatedHeight() { return 48; }
  // A tap on a button is not a tap in the text.
  ignoreEvent() { return true; }

  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-mention-card cm-mention-card--${this.card.tone}`;
    el.setAttribute("role", "status");
    // Not selectable text of the note: the caret never lands in a card.
    el.contentEditable = "false";
    const text = document.createElement("span");
    text.className = "cm-mention-card-text";
    text.textContent = this.card.text;
    el.append(text);
    if (this.card.detail) {
      const detail = document.createElement("div");
      detail.className = "cm-mention-card-detail";
      detail.textContent = this.card.detail;
      el.append(detail);
    }
    for (const button of this.card.actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `cm-mention-card-btn cm-mention-card-btn--${button.action}`;
      b.textContent = button.label;
      b.disabled = !!button.disabled || !!button.busy;
      if (button.busy) b.setAttribute("aria-busy", "true");
      // Keep the editor's focus (and the phone's keyboard) where it is.
      b.addEventListener("pointerdown", (event) => event.preventDefault());
      b.addEventListener("click", () => this.host.onAction(this.card.key, button.action));
      el.append(b);
    }
    return el;
  }
}

function build(cards: readonly MentionCard[], docLength: number, host: MentionCardHost): DecorationSet {
  const ranges = [...cards]
    .sort((a, b) => a.at - b.at)
    .map((card) => Decoration.widget({ widget: new CardWidget(card, host), block: true, side: 1 }).range(Math.min(card.at, docLength)));
  return Decoration.set(ranges);
}

/** The cards under mentions. `host` is stable for the editor's life. */
export function mentionCardsExtension(host: MentionCardHost): Extension {
  const field = StateField.define<{ cards: MentionCard[]; decorations: DecorationSet }>({
    create: () => ({ cards: [], decorations: Decoration.none }),
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setMentionCards)) {
          // The host may place cards in text the editor has not received yet
          // (a send writes the mention's ^id first): keep them inside this doc,
          // or the next change's mapPos throws on a position past its end.
          const cards = effect.value.map((card) => ({ ...card, at: Math.min(card.at, tr.state.doc.length) }));
          return { cards, decorations: build(cards, tr.state.doc.length, host) };
        }
      }
      if (!tr.docChanged) return value;
      const before = tr.startState.doc.length;
      const cards = value.cards.map((card) => ({ ...card, at: tr.changes.mapPos(Math.min(card.at, before), 1) }));
      return { cards, decorations: build(cards, tr.state.doc.length, host) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });
  return field;
}
