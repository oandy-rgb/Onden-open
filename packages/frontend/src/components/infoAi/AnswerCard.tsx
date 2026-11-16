import { useCallback, useEffect, useRef } from "react";
import { Copy, Square } from "lucide-react";
import { t } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { copyText } from "../../lib/clipboard";
import { selectedTextWithin } from "../../lib/noteChatDom";
import { displayTitle } from "../../lib/noteLabel";
import { chatFailureText, stepLine, suggestionLine, turnIsOpen, waitingLine } from "../../lib/noteChat";
import type { ChatTurn } from "@onden/contract";
import type { ContentNode } from "../../lib/api";
import { useNowMs } from "../../hooks/useNowMs";
import { useAllNodes } from "../../lib/appStore";
import { AiAnswer } from "../markdownSurfaces";
import type { LiveAnswer } from "./useNoteChat";
import { Button, Chip, Pressable } from "../ui";

// One question and its answer. While the answer is being written the text so far is shown with what the
// AI is doing now; a finished one has its sources (notes it read, a paragraph where it named one),
// 「放進筆記」 and 「複製」, and — when it proposed edits — how many places wait and a way to decide them.

export default function AnswerCard({ turn, live, canEdit, online, onOpenSource, onPut, onDecide, onJumpToSuggestions, onStop }: {
  turn: ChatTurn; live: LiveAnswer | null; canEdit: boolean; online: boolean;
  onOpenSource: (source: { node_id: string; block_id: string | null }) => void;
  onPut: (text: string) => void;
  onDecide: (decision: "accept" | "reject") => void;
  onJumpToSuggestions: () => void;
  onStop: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const nodes = useLinkTargets();
  const open = turnIsOpen(turn);
  const shown = live ? live.text : turn.reply ?? "";
  const scopeNames = [...turn.scope.notes.map((n) => displayTitle(n.title)), ...turn.scope.tags.map((tag) => `#${tag.name}`)];
  const proposed = suggestionLine(turn);

  // Put in only the part the person selected inside this answer, else the whole answer.
  const selected = (): string => {
    return selectedTextWithin(body.current);
  };
  const copy = () => { void copyText(selected() || turn.reply || ""); };
  // One function for the life of the card: the Markdown reader rebuilds every element of the answer when the function it is given
  // changes, and a rebuilt paragraph drops the text the person had selected in it (the copy bar closed by itself, tablet 2026-11-16).
  const openSource = useRef(onOpenSource);
  useEffect(() => { openSource.current = onOpenSource; });
  const navigate = useCallback((_slug: string, nodeId: string | null, blockId?: string) => {
    if (nodeId) openSource.current({ node_id: nodeId, block_id: blockId ?? null });
  }, []);

  return (
    <article className="note-ai-turn" aria-label={t("A question to the AI")}>
      <p className="note-ai-question">{turn.text}</p>
      {scopeNames.length > 0 && (
        <p className="note-ai-scope">{scopeNames.map((name) => <Chip key={name} tone="neutral">{name}</Chip>)}</p>
      )}
      <div className="note-ai-answer" ref={body}>
        {live && live.step && <p className="note-ai-step" role="status">{stepLine(live.step)}</p>}
        {open && !live && !shown && <WaitingLine turn={turn} />}
        {shown && (
          // The answer is the AI's text, so it is drawn by the app's one Markdown reader (the surface that shows raw HTML as text); [[links]] open the note.
          <div className="note-ai-text obsidian-preview obsidian-preview--md">
            <AiAnswer nodes={nodes} onNavigate={navigate}>{shown}</AiAnswer>
          </div>
        )}
        {turn.status === "failed" && <p className="note-ai-failed" role="alert">{chatFailureText(turn.fail_code)}</p>}
        {turn.status === "cancelled" && <p className="note-ai-step">{t("Stopped.")}</p>}
      </div>
      {open && <div className="note-ai-actions"><Button size="sm" variant="ghost" onClick={onStop}>{turn.runtime === "api" ? <><Square size={12} aria-hidden="true" />{t("Stop")}</> : t("Cancel")}</Button></div>}
      {turn.status === "completed" && turn.reply && (
        <>
          {turn.sources.length > 0 && (
            <div className="note-ai-sources" aria-label={t("Sources")}>
              <span className="note-ai-sources-label">{t("Sources")}</span>
              <ul>
                {turn.sources.map((source) => (
                  <li key={source.node_id}>
                    <Pressable className="note-ai-source" onClick={() => onOpenSource(source)}>
                      {displayTitle(source.title)}{source.block_id ? <span className="note-ai-source-block">{t("paragraph")}</span> : null}
                    </Pressable>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {proposed && (
            <div className="note-ai-proposed">
              <span>{proposed}</span>
              {turn.suggestions.pending > 0 && (
                <span className="note-ai-actions">
                  <Button size="sm" variant="ghost" onClick={onJumpToSuggestions}>{t("See in the note")}</Button>
                  {canEdit && <Button size="sm" variant="primary" disabled={!online} onClick={() => onDecide("accept")}>{t("Accept all")}</Button>}
                  {canEdit && <Button size="sm" variant="secondary" disabled={!online} onClick={() => onDecide("reject")}>{t("Discard all")}</Button>}
                </span>
              )}
            </div>
          )}
          <div className="note-ai-actions">
            {canEdit && <Button size="sm" variant="secondary" onClick={() => onPut(selected() || turn.reply!)}>{t("Put into the note")}</Button>}
            <Button size="sm" variant="ghost" onClick={copy}><Copy size={12} aria-hidden="true" />{t("Copy")}</Button>
          </div>
        </>
      )}
    </article>
  );
}

/** What a question still waiting for its AI says. Its own component: it re-reads the time now and then (so a question nobody
 *  picks up turns into a plain note about it), and that must not redraw a card whose answer is already there. */
function WaitingLine({ turn }: { turn: ChatTurn }) {
  const waiting = waitingLine(turn, useNowMs(10_000));
  return waiting ? <p className={classNames("note-ai-step", waiting.stuck && "note-ai-step--stuck")} role="status">{waiting.text}</p> : null;
}

/** The notes a [[link]] in an answer can name, as the same array until one of them is added, removed, renamed or moved to another
 *  space. The store hands out a new array for every save of any note; given that, the Markdown reader would rebuild the answer
 *  (and drop the selection) each time the note beside the panel is saved. */
function useLinkTargets(): ContentNode[] {
  const nodes = useAllNodes();
  const held = useRef<{ nodes: ContentNode[]; names: string }>({ nodes, names: "" });
  const names = nodes.map((n) => `${n.id}\u0000${n.title}\u0000${n.slug}\u0000${n.space_id ?? ""}\u0000${n.deleted_at ? 1 : 0}`).join("\u0001");
  if (held.current.names !== names) held.current = { nodes, names };
  return held.current.nodes;
}
