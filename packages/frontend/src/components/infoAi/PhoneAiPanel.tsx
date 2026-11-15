import { useCallback } from "react";
import { Maximize2, Minimize2, Sparkles, X } from "lucide-react";
import type { ContentNode } from "../../lib/api";
import { aiLabel } from "../../lib/actorLabel";
import { activeElement } from "../../lib/documentAccess";
import { useT } from "../../lib/i18n";
import { barLine, turnIsOpen } from "../../lib/noteChat";
import { dismissNoteAi, setNoteAiHeight, useNoteAiPanel } from "../../lib/notePhoneAi";
import { useDismiss } from "../../hooks/useEscapeKey";
import { useNowMs } from "../../hooks/useNowMs";
import { Button, DockedSheet, Pressable, SheetHeader, type SheetDockHeight } from "../ui";
import { NoteAiConversation } from "./NoteAiConversation";
import { useNoteAi } from "./useNoteAi";
import "./NoteAiConversation.css";

// The phone's frame of the AI conversation: a bottom panel over the open note (ui/DockedSheet), because the
// Info screen replaces the note and a question must not mean leaving it. Three heights — a one-row bar that
// says what is going on while the note stays editable, half the screen, and full — kept in lib/notePhoneAi.
// Back and Esc go down one height (full → half → bar) through the dismiss stack; from the bar, Back leaves the note as usual. The bar
// exists after the panel was opened for this note, or while an answer is pending; the conversation lives here
// even when it is only a bar, so the bar can read it. Mounted by NotePhoneAiHost, only for a note it was opened for.

/** Take focus out of a field inside the panel (the keyboard goes down). With `onlyWithKeyboard`: only while the
 *  keyboard is up; says whether it did. */
function blurPanelField(onlyWithKeyboard = false): boolean {
  const focused = activeElement();
  const dock = focused instanceof HTMLElement ? focused.closest(".ui-sheet-dock") : null;
  if (!(focused instanceof HTMLElement) || !dock || (onlyWithKeyboard && !dock.hasAttribute("data-keyboard"))) return false;
  focused.blur();
  return true;
}

export default function PhoneAiPanel({ node, onSelectNode }: { node: ContentNode; onSelectNode: (id: string) => void }) {
  const t = useT();
  const ai = useNoteAi(node);
  const panel = useNoteAiPanel(node.id);
  const now = useNowMs(10_000);
  const { chat } = ai;
  const pending = chat.sending || chat.live !== null || chat.turns.some(turnIsOpen);
  const shown = !!panel && (!panel.dismissed || pending);
  const height: SheetDockHeight = !panel || panel.dismissed ? "bar" : panel.height;

  const change = useCallback((next: SheetDockHeight) => {
    if (next === "bar") blurPanelField(); // the keyboard goes down with the panel
    setNoteAiHeight(node.id, next);
  }, [node.id]);
  // Esc and Back leave through the one dismiss stack, one height at a time. A close watcher serves one request, so
  // each height that can be left registers by itself: full → half, then half → bar. At the bar nothing is registered:
  // Back then leaves the note as usual. While the keyboard is up in the panel, the first request only closes it.
  const lower = (to: SheetDockHeight) => () => { if (!blurPanelField(true)) change(to); };
  useDismiss(lower("half"), shown && height === "full");
  useDismiss(lower("bar"), shown && height === "half");

  if (!shown) return null;
  const sizeLabel = height === "full" ? t("Half screen") : t("Full screen");
  const sizeToggle = (
    <Button variant="ghost" aria-label={sizeLabel} title={sizeLabel} onClick={() => change(height === "full" ? "half" : "full")}>
      {height === "full" ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
    </Button>
  );
  const line = barLine(chat.turns, chat.live?.text ?? "", now);
  const quiet = !pending && !chat.turns.some((x) => x.status === "completed" && x.reply);
  return (
    <DockedSheet label={aiLabel()} className="phone-ai"
      dock={{
        height, onHeightChange: change,
        bar: (
          <div className="phone-ai-bar" data-pending={pending || undefined}>
            <Pressable className="phone-ai-bar-open" onClick={() => change("half")}>
              <Sparkles size={16} className="phone-ai-bar-icon" aria-hidden="true" />
              <span className={quiet ? "phone-ai-bar-text phone-ai-bar-text--quiet" : "phone-ai-bar-text"} role="status">{line}</span>
            </Pressable>
            {!pending && (
              <Button variant="icon" size="sm" aria-label={t("Hide the AI bar")} title={t("Hide the AI bar")} onClick={() => dismissNoteAi(node.id)}>
                <X size={16} aria-hidden="true" />
              </Button>
            )}
          </div>
        ),
      }}>
      <SheetHeader title={aiLabel()} onClose={() => change("bar")} actions={sizeToggle} />
      <div className="phone-ai-body">
        <NoteAiConversation node={node} ai={ai} onSelectNode={onSelectNode} onRevealNote={() => change("bar")} />
      </div>
    </DockedSheet>
  );
}
