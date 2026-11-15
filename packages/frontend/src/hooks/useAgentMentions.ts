import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { findMentions } from "@onden/markdown";
import { addToast } from "../lib/appStore";
import { drafts, onlineOperation, reads } from "../lib/data";
import { t } from "../lib/i18n";
import { anchorSpansOf, anchorsVersion, watchAnchors, type AnchorSpan } from "../lib/blockAnchorStore";
import {
  handOffMention, isOpenSession, mentionCards, mentionKey, type AgentSessionBrief, type MentionAction, type MentionAgents, type MentionCard, type MentionableAgent,
} from "../lib/agentMentions";

/** How often an open request is looked at again (no live push for sessions yet). */
const POLL_MS = 3_000;

type SendResult = { created: boolean; session: AgentSessionBrief };

/** The `@ai` mentions of the open note: which AI can be asked, the requests
 *  already sent, and the three things a person does with one — send it, cancel
 *  it, send it again. Sending goes through the one online write path (an
 *  Idempotency-Key per attempt, so a retry after a lost reply is the same
 *  request) and only after the note itself is saved, because the server reads
 *  the mention from the saved note. A mention is a block of the note, found by
 *  its anchor (lib/blockAnchorStore) or, before it has one, by its words; sending
 *  makes the server give it an anchor — nothing is written into the text — and
 *  the card follows that anchor from then on. Nothing here shows "sent" before
 *  the server said so.
 *  `onMarkdownChange` writes the note's text (the editor's own change handler). */
export function useAgentMentions({ nodeId, markdown, canEdit, online, onMarkdownChange, waitingReplies, onReplyInserted }: {
  nodeId: string | undefined; markdown: string; canEdit: boolean; online: boolean; onMarkdownChange: (next: string) => void;
  /** Sessions whose reply is already a pending suggestion, and what to do once a reply was filed as one. */
  waitingReplies?: ReadonlySet<string>; onReplyInserted?: () => void;
}) {
  const [known, setKnown] = useState<MentionAgents | null>(null);
  const [sessions, setSessions] = useState<ReadonlyMap<string, AgentSessionBrief>>(new Map());
  const [busy, setBusy] = useState<{ key: string; action: MentionAction } | null>(null);
  const [tick, setTick] = useState(0);
  const nodeRef = useRef(nodeId);
  nodeRef.current = nodeId;
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;
  const busyRef = useRef(false);

  // Where the note's paragraphs are, as the server's anchors say. A request just sent made an anchor the sync has not
  // brought yet: until it does, the answer's own anchor id names that block, for as long as the text is the one sent.
  const anchorVersion = useSyncExternalStore(watchAnchors, anchorsVersion, () => 0);
  const [made, setMade] = useState<{ nodeId: string; text: string; anchors: AnchorSpan[] } | null>(null);
  const anchors = useMemo(() => {
    if (!nodeId) return [];
    const held = anchorSpansOf(nodeId, markdown);
    const extra = made && made.nodeId === nodeId && made.text === markdown ? made.anchors.filter((a) => !held.some((h) => h.id === a.id)) : [];
    return [...held, ...extra];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, markdown, anchorVersion, made]);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  // A different note: nothing of the last one is kept.
  useEffect(() => {
    setKnown(null); setSessions(new Map()); setBusy(null); setMade(null);
  }, [nodeId]);

  const refreshKnown = useCallback(async () => {
    const id = nodeRef.current;
    if (!id) return;
    try {
      const body = await reads.agentMentions.mentionables<{ agents: MentionableAgent[]; default_actor_id: string | null }>(id);
      if (nodeRef.current === id) setKnown({ agents: body.agents, defaultActorId: body.default_actor_id });
    } catch { if (nodeRef.current === id) setKnown(null); }
  }, []);

  const refreshSessions = useCallback(async () => {
    const id = nodeRef.current;
    if (!id) return;
    try {
      const body = await reads.agentMentions.sessions<AgentSessionBrief>(id);
      if (nodeRef.current !== id) return;
      setSessions(new Map(body.sessions.map((s) => [s.anchor_block_id, s])));
    } catch { /* offline or not allowed: the cards show what we last knew */ }
  }, []);

  // Only a note whose mentions can matter is looked up at all.
  const hasMention = useMemo(() => markdown.includes("@") && findMentions(markdown, anchors).length > 0, [markdown, anchors]);
  useEffect(() => {
    if (!nodeId || !online || !hasMention) return;
    void refreshKnown();
    void refreshSessions();
  }, [nodeId, online, hasMention, refreshKnown, refreshSessions]);

  const anyOpen = [...sessions.values()].some((s) => isOpenSession(s.status));
  useEffect(() => {
    if (!anyOpen || !online) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshSessions();
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyOpen, online, refreshSessions]);

  const cards: MentionCard[] = useMemo(
    () => mentionCards({ markdown, anchors, known, sessions, online, canEdit, now: Date.now(), busy, waitingReplies }),
    // `tick` moves the clock on for "received it but hasn't answered".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markdown, anchors, known, sessions, online, canEdit, busy, tick, waitingReplies],
  );

  const remember = useCallback((session: AgentSessionBrief) => {
    setSessions((prev) => new Map(prev).set(session.anchor_block_id, session));
  }, []);

  /** Run `action` for the mention with this key. Resolves true when the server took it. */
  const act = useCallback(async (key: string, action: MentionAction): Promise<boolean> => {
    const id = nodeRef.current;
    if (!id || busyRef.current) return false;
    const text = markdownRef.current;
    const mention = findMentions(text, anchorsRef.current).find((m) => mentionKey(text, m) === key);
    const current = mention?.blockId ? sessions.get(mention.blockId) : undefined;
    if (!mention || (action !== "send" && !current)) return false;
    busyRef.current = true;
    setBusy({ key, action });
    try {
      if (action === "cancel") {
        const result = await onlineOperation(`agent-mention:${id}:${key}`, t("Cancelling needs a connection."),
          (submit) => submit<{ session: AgentSessionBrief }>(`/api/agent-sessions/${current!.id}/cancel`));
        if ("session" in result) remember(result.session);
        return "session" in result;
      }
      if (action === "insert") {
        // A suggest-mode AI's reply goes into the note as ONE suggestion; the person accepts it in the text.
        await onlineOperation(`agent-mention-insert:${id}:${key}`, t("Adding the reply needs a connection."),
          (submit) => submit<{ suggestionId: string | null }>(`/api/agent-sessions/${current!.id}/insert-reply`));
        void refreshSessions();
        onReplyInserted?.();
        return true;
      }
      if (!(await drafts.flush())) {
        addToast(t("The note couldn't be saved, so nothing was sent. Your text is kept."), "error");
        return false;
      }
      // The server reads the mention from the note it holds: by the block's anchor, or by its words while it has none.
      const blockId = current?.anchor_block_id ?? mention.blockId;
      const body = JSON.stringify({
        node_id: id, ...(blockId ? { block_id: blockId } : { block_text: text.slice(mention.blockStart, mention.blockEnd).trim() }),
        ...(action === "retry" ? { resend: true } : {}),
      });
      const result = await onlineOperation(`agent-mention:${id}:${blockId ?? key}`, t("Sending needs a connection."),
        (submit) => submit<SendResult>("/api/agent-sessions", body));
      if ("session" in result) {
        remember(result.session);
        if (!blockId) setMade({ nodeId: id, text, anchors: [{ id: result.session.anchor_block_id, from: mention.blockStart, to: mention.blockEnd }] });
      }
      return "session" in result;
    } catch { return false; /* the online write path already told the person why; the card stays so they can try again */ }
    finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [sessions, remember, refreshSessions, onReplyInserted]);

  // A skill button writes `@ai /[[skill]]` and sends it as soon as the note shows it.
  const handingOff = useRef<string | null>(null);
  const handOff = useCallback((skillTitle: string) => {
    const mention = handOffMention(skillTitle);
    const text = markdownRef.current;
    // Already written and not sent: send that one instead of writing a twin.
    const waiting = findMentions(text, anchorsRef.current).find((m) => !m.blockId && text.slice(m.blockStart, m.blockEnd).trim() === mention);
    handingOff.current = `text:${mention}`;
    if (!waiting) onMarkdownChange(`${text.replace(/\s+$/, "")}${text.trim() ? "\n\n" : ""}${mention}\n`);
    setTick((n) => n + 1);
  }, [onMarkdownChange]);
  useEffect(() => {
    const key = handingOff.current;
    if (!key || busyRef.current) return;
    const card = cards.find((c) => c.key === key);
    if (!card) return;
    handingOff.current = null;
    const send = card.actions.find((a) => a.action === "send");
    // A blocker (no AI, offline, switched off) stays on the card as its sentence.
    if (send && !send.disabled) void act(key, "send");
  }, [cards, act]);

  return { cards, known, refreshKnown, act, handOff };
}
