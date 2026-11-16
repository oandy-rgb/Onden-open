import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useT } from "../../lib/i18n";
import { revealBlockInNote } from "../../lib/noteReveal";
import { scrollToSuggestionBar } from "../../lib/noteChatDom";
import { aiLabel } from "../../lib/actorLabel";
import { targetLine } from "../../lib/handToAi";
import { confirmDialog } from "../ConfirmDialog";
import { openSpacesAndMembers } from "../../lib/settingsRequest";
import type { ContentNode } from "../../lib/api";
import { Button, Select } from "../ui";
import AnswerCard from "./AnswerCard";
import ScopeBox from "./ScopeBox";
import type { NoteAi } from "./useNoteAi";
import "./NoteAiConversation.css";

// The conversation about one note, in the info panel's 「AI」 tab and in the phone's bottom panel — the same
// component in both frames (InfoAiTab, PhoneAiPanel): who answers, the questions and answers (newest at the
// bottom), three starters while it is empty, what the AI will read, and the box to ask in. The frame owns the
// conversation (useNoteAi) and decides where it lives; this draws it and never learns which frame it is in.
// The conversation belongs to the note and stays on the server (services/panelChat.ts); 「清除這段對話」 starts it over.

export function NoteAiConversation({ node, ai, onSelectNode, onRevealNote }: {
  node: ContentNode;
  ai: NoteAi;
  /** Open a note from a source link. */
  onSelectNode: (id: string) => void;
  /** The person's next step is in the note (an answer put in, edits to decide, a source in this note): a frame
   *  that covers the note steps aside. */
  onRevealNote?: () => void;
}) {
  const t = useT();
  const { chat, online, canEdit } = ai;
  const thread = useRef<HTMLDivElement>(null);
  const liveText = chat.live?.text.length ?? 0;
  const lastTurn = chat.turns[chat.turns.length - 1];
  const last = lastTurn?.session_id;
  const answered = lastTurn?.status === "completed";
  // Newest at the bottom: follow a question and the answer as it is written. A finished answer lands as a whole (or the
  // stream ends): show it from its first line, with its question, rather than from its last.
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.turns.length, last, liveText, chat.live?.step]);
  useEffect(() => {
    const el = thread.current;
    const turn = el?.querySelector<HTMLElement>(".note-ai-turn:last-of-type");
    if (el && turn && answered) el.scrollTop = turn.offsetTop - el.offsetTop;
  }, [answered, last]);

  const openSource = (source: { node_id: string; block_id: string | null }) => {
    if (source.block_id) revealBlockInNote(source.node_id, source.block_id);
    if (source.node_id === node.id) onRevealNote?.();
    else onSelectNode(source.node_id);
  };
  const jumpToSuggestions = () => {
    onRevealNote?.();
    scrollToSuggestionBar();
  };
  const put = async (text: string) => { if (await chat.putIntoNote(text)) onRevealNote?.(); };
  const clear = async () => {
    const yes = await confirmDialog(t("The questions and answers here are removed. The note is not changed."), { title: t("Clear this conversation?"), confirmLabel: t("Clear"), danger: true });
    if (yes) await chat.clear();
  };

  const choices = chat.roles.flatMap((role) => role.reason === null
    ? role.runtimes.filter((r) => r.available).map((r) => ({ value: `${role.actor_id}|${r.kind}`, label: targetLine({ role, runtime: r.kind }) }))
    : []);
  const chosen = chat.entry.target ? `${chat.entry.target.role.actor_id}|${chat.entry.target.runtime}` : "";
  const empty = chat.loaded && chat.turns.length === 0 && !chat.entry.blocked;
  const starters = [
    { label: t("Summarize this note"), question: t("Summarize this note.") },
    { label: t("Find related notes"), question: t("Which other notes relate to this one?") },
    { label: t("Suggest improvements"), question: t("Suggest improvements to this note.") },
  ];

  // Who answers. A choice when there is one to make; the AI's name when it has one of its own. An AI simply called "AI", one way
  // to reach it: the tab (or the panel's header) already says it, so the line is left out instead of repeating the word.
  const who = chat.entry.target ? targetLine(chat.entry.target) : null;
  const headLine = chat.entry.target
    ? (choices.length > 1
      ? <Select className="note-ai-who" value={chosen} aria-label={t("Who answers")}
          onChange={(event) => { const [roleId, runtime] = event.target.value.split("|"); chat.setPick({ roleId, runtime }); }}>
          {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </Select>
      : who !== aiLabel() ? <span className="note-ai-line">{who}</span> : null)
    : <span className="note-ai-line">{chat.options ? t("No AI can answer") : t("Looking for an AI…")}</span>;
  const canClear = chat.turns.length > 0 && !chat.busy;

  return (
    <section className="note-ai" aria-label={aiLabel()}>
      {(headLine !== null || canClear) && <header className="note-ai-head">
        {headLine ?? <span />}
        {canClear && (
          <Button variant="icon" size="sm" aria-label={t("Clear this conversation")} title={t("Clear this conversation")} disabled={!online} onClick={() => void clear()}>
            <Trash2 size={14} aria-hidden="true" />
          </Button>
        )}
      </header>}

      {chat.entry.blocked && (
        <div className="note-ai-blocked" role="note">
          <p>{chat.entry.blocked}</p>
          {online && <Button size="sm" variant="secondary" onClick={() => openSpacesAndMembers()}>{t("Open AI settings")}</Button>}
        </div>
      )}

      <div className="note-ai-thread" ref={thread} aria-live="polite">
        {empty && (
          <div className="note-ai-intro">
            <p className="note-ai-quiet">{t("Ask about this note. The AI changes nothing until you agree.")}</p>
            <ul className="note-ai-starters" aria-label={t("Ways to start")}>
              {starters.map((starter) => (
                <li key={starter.label}>
                  <Button size="sm" variant="secondary" disabled={!chat.entry.target || chat.busy} onClick={() => void chat.send(starter.question)}>{starter.label}</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {chat.turns.map((turn) => (
          <AnswerCard key={turn.session_id} turn={turn} canEdit={canEdit} online={online}
            live={chat.live?.sessionId === turn.session_id ? chat.live : null}
            onOpenSource={openSource} onPut={(text) => void put(text)}
            onDecide={(decision) => void chat.decide(turn, decision)} onJumpToSuggestions={jumpToSuggestions}
            onStop={() => void chat.cancel(turn.session_id)} />
        ))}
      </div>

      {/* No AI can answer: the reason and the way to settings above say it all; a box to type in would only lead nowhere. */}
      {!chat.entry.blocked && <div className="note-ai-composer">
        <ScopeBox nodeId={node.id} noteTitle={node.title} chips={chat.chips} text={chat.text} sending={chat.sending}
          disabled={!chat.entry.target} canSend={!!chat.text.trim() && !!chat.entry.target && !chat.busy}
          onText={chat.setText} onAdd={chat.addScope} onRemove={chat.removeScope} onSend={() => void chat.send()} />
      </div>}
    </section>
  );
}
