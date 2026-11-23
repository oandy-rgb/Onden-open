import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addToast } from "../../lib/appStore";
import { getApiBase } from "../../lib/api";
import { drafts, onlineOperation, reads } from "../../lib/data";
import { t } from "../../lib/i18n";
import { randomUUID } from "../../lib/uuid";
import { pollWhileVisible } from "../../lib/noteChatDom";
import { insertIntoNoteEditor } from "../../lib/editorInsert";
import { announceSuggestionsChanged } from "../../lib/aiSuggestionsBus";
import { useSpaces } from "../../lib/spaces";
import type { HandOptions, HandPick } from "../../lib/handToAi";
import {
  addChip, additionAtEnd, chatEntry, chipsToScope, insertion, removeChip, turnIsOpen, withoutAddition,
  type ScopeChip,
} from "../../lib/noteChat";
import type { ChatTurn } from "@onden/contract";

const POLL_MS = 3_000;

export type LiveAnswer = { sessionId: string; text: string; step: { what: "read" | "search" | "write"; title: string | null } | null };

/** The info panel's 「AI」 tab for the open note: who can answer, this person's conversation (kept on the
 *  server, so another device or the next visit sees it), the scope chips, and the one question in flight.
 *  Asking goes through the online write path with a request id that stays the same until the server took
 *  the question, so a lost reply never asks twice. Nothing says "answered" before the server did. */
export function useNoteChat({ nodeId, online, canEdit, reasonText }: {
  nodeId: string; online: boolean; canEdit: boolean; reasonText: (code: string | null) => string;
}) {
  const [options, setOptions] = useState<HandOptions | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pick, setPick] = useState<HandPick>({});
  const [chips, setChips] = useState<ScopeChip[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState<LiveAnswer | null>(null);
  const nodeRef = useRef(nodeId);
  nodeRef.current = nodeId;
  // Who can answer depends on the spaces' AI switches and members. Every change to them (Settings here, another
  // device through the sync's membership epoch) reloads the spaces, so that reload is the signal to ask again.
  const { spaces } = useSpaces(online);
  const stopRef = useRef<() => void>(() => {});
  const requestRef = useRef<{ key: string; id: string } | null>(null);

  const reloadThread = useCallback(async (): Promise<ChatTurn[]> => {
    const id = nodeRef.current;
    try {
      const body = await reads.panelChat.thread<{ turns: ChatTurn[] }>(id);
      const all = Array.isArray(body.turns) ? body.turns : [];
      if (nodeRef.current === id) { setTurns(all); setLoaded(true); }
      return all;
    } catch { return []; /* offline for a moment: what was shown stays */ }
  }, []);

  const follow = useCallback((sessionId: string) => {
    stopRef.current();
    setLive({ sessionId, text: "", step: null });
    const source = new EventSource(`${getApiBase()}/api/ai/selection-actions/${sessionId}/stream`, { withCredentials: true });
    let ended = false;
    const end = () => {
      ended = true;
      source.close();
      stopRef.current = () => {};
      setLive(null);
      void reloadThread().then((all) => {
        const turn = all.find((x) => x.session_id === sessionId);
        // The AI may have filed suggestions: the editor's bar reads them again.
        if (turn && turn.suggestions.pending > 0) announceSuggestionsChanged(nodeRef.current, false);
      });
    };
    source.onmessage = (message) => {
      let frame: { kind?: string; text?: string; what?: "read" | "search" | "write"; title?: string | null };
      try { frame = JSON.parse(message.data); } catch { return; }
      if (frame.kind === "text" && typeof frame.text === "string") {
        const delta = frame.text;
        setLive((current) => (current?.sessionId === sessionId ? { ...current, text: current.text + delta, step: null } : current));
      } else if (frame.kind === "restart") {
        setLive((current) => (current?.sessionId === sessionId ? { ...current, text: "" } : current));
      } else if (frame.kind === "step" && frame.what) {
        const step = { what: frame.what, title: frame.title ?? null };
        setLive((current) => (current?.sessionId === sessionId ? { ...current, step } : current));
      } else if (frame.kind === "end") end();
    };
    // A dropped connection: the browser retries by itself; a closed one means the thread is the truth now.
    source.onerror = () => { if (!ended && source.readyState === EventSource.CLOSED) end(); };
    stopRef.current = () => source.close();
  }, [reloadThread]);

  // A different note: nothing of the last one is kept.
  useEffect(() => {
    stopRef.current(); stopRef.current = () => {};
    setOptions(null); setTurns([]); setLoaded(false); setPick({}); setChips([]); setText(""); setLive(null); setSending(false);
    requestRef.current = null;
    if (!online) return;
    let cancelled = false;
    void reloadThread().then((all) => {
      // An answer still being written (this tab was closed, or another device asked): follow it.
      const open = all.find(turnIsOpen);
      if (open && !cancelled && open.runtime === "api") follow(open.session_id);
    });
    return () => { cancelled = true; };
  }, [nodeId, online, reloadThread, follow]);
  useEffect(() => () => stopRef.current(), []);

  // Who can answer: asked for the note, and again whenever the spaces change, without closing the panel. The earlier
  // answer stays on screen until the new one arrives, so a refresh does not flash "looking for an AI".
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    reads.panelChat.roles<{ roles: HandOptions["roles"] }>(nodeId)
      .then((body) => { if (!cancelled) setOptions({ can_hand_off: true, roles: Array.isArray(body.roles) ? body.roles : [] }); })
      .catch(() => { /* a failed reload keeps the last answer; a new note already cleared it above */ });
    return () => { cancelled = true; };
  }, [nodeId, online, spaces]);

  // Subscription / MCP answers do not stream: look at the thread again while one is open.
  const waiting = turns.some(turnIsOpen) && live === null;
  useEffect(() => {
    if (!waiting) return;
    return pollWhileVisible(() => { void reloadThread(); }, POLL_MS);
  }, [waiting, reloadThread]);

  const entry = useMemo(() => chatEntry({ online, options, pick, reasonText }), [online, options, pick, reasonText]);
  const busy = sending || live !== null || turns.some(turnIsOpen);

  const addScope = useCallback((chip: ScopeChip) => setChips((all) => addChip(all, chip, nodeRef.current)), []);
  const removeScope = useCallback((chip: ScopeChip) => setChips((all) => removeChip(all, chip)), []);

  /** Ask the question in the box, or — a starter — this one, leaving what is typed in the box alone. */
  const send = useCallback(async (override?: string): Promise<boolean> => {
    const question = (override ?? text).trim();
    const target = entry.target;
    if (!question || !target || entry.blocked || busy) return false;
    const id = nodeRef.current;
    setSending(true);
    try {
      // The server reads the saved note: the text on screen is saved first.
      if (!(await drafts.flush())) {
        addToast(t("The note couldn't be saved, so nothing was sent. Your text is kept."), "error");
        return false;
      }
      const scope = chipsToScope(chips);
      const key = JSON.stringify([id, question, scope, target.role.actor_id, target.runtime]);
      if (requestRef.current?.key !== key) requestRef.current = { key, id: randomUUID() };
      const requestId = requestRef.current.id;
      const result = await onlineOperation(`panel-chat:${id}:${requestId}`, t("Asking the AI needs a connection."), (submit) => submit<{ session_id: string }>(
        "/api/ai/panel-chat",
        JSON.stringify({ agent_actor_id: target.role.actor_id, node_id: id, text: question, request_id: requestId, runtime: target.runtime, ...scope })));
      requestRef.current = null;
      if (nodeRef.current !== id) return true;
      if (override === undefined) setText("");
      if ("deduped" in result) { await reloadThread(); return true; }
      await reloadThread();
      if (target.runtime === "api") follow(result.session_id);
      return true;
    } catch {
      return false; // the online write path already told the person why; the question stays in the box
    } finally {
      setSending(false);
    }
  }, [text, entry, busy, chips, reloadThread, follow]);

  const cancel = useCallback(async (sessionId: string) => {
    try {
      await onlineOperation(`panel-chat-cancel:${sessionId}`, t("Stopping needs a connection."),
        (submit) => submit(`/api/agent-sessions/${sessionId}/cancel`));
    } catch { return; /* told already; it keeps running */ }
    stopRef.current(); stopRef.current = () => {};
    setLive(null);
    await reloadThread();
  }, [reloadThread]);

  const clear = useCallback(async (): Promise<boolean> => {
    const id = nodeRef.current;
    try {
      await onlineOperation(`panel-chat-clear:${id}`, t("Clearing the conversation needs a connection."),
        (submit) => submit(`/api/ai/panel-chat/${encodeURIComponent(id)}`, undefined, "DELETE"));
    } catch { return false; }
    setTurns([]);
    return true;
  }, []);

  /** Accept or turn down every place this answer proposed (one request per suggestion; the editor reads them again). */
  const decide = useCallback(async (turn: ChatTurn, decision: "accept" | "reject"): Promise<boolean> => {
    const id = nodeRef.current;
    if (decision === "accept" && !(await drafts.flush())) {
      addToast(t("The note couldn't be saved, so nothing was accepted. Your text is kept."), "error");
      return false;
    }
    const bySuggestion = new Map<string, string[]>();
    for (const p of turn.pending) bySuggestion.set(p.suggestion_id, [...(bySuggestion.get(p.suggestion_id) ?? []), p.item_id]);
    let noteChanged = false;
    try {
      for (const [suggestionId, itemIds] of bySuggestion) {
        const result = await onlineOperation(`ai-suggestion:${id}:${suggestionId}`, t("Accepting or rejecting needs a connection."),
          (submit) => submit<{ accepted?: string[] }>(`/api/ai-suggestions/${suggestionId}/${decision}`, JSON.stringify({ item_ids: itemIds })));
        if (decision === "accept" && (!("deduped" in result) ? (result.accepted?.length ?? 0) > 0 : true)) noteChanged = true;
      }
    } catch { /* told already; the places stay, so the person can try again */ }
    announceSuggestionsChanged(id, noteChanged);
    await reloadThread();
    return true;
  }, [reloadThread]);

  const lastInsert = useRef<{ nodeId: string; added: string } | null>(null);
  /** Take the answer back out, only while it is still there exactly as it was put in. */
  const undoInsert = useCallback(async (): Promise<boolean> => {
    const last = lastInsert.current;
    if (!last) return false;
    let removed = false;
    const result = await drafts.editText(last.nodeId, (body) => {
      const next = withoutAddition(body, last.added);
      removed = next !== null;
      return next ?? body;
    });
    if (result !== "applied" || !removed) {
      addToast(t("The answer has been changed since, so it was left in. Use the note's versions to go back."), "info");
      return false;
    }
    lastInsert.current = null;
    return true;
  }, []);

  /** 「放進筆記」: the person's own edit, written like typing (at the caret of the open editor, else at the end). */
  const putIntoNote = useCallback(async (answer: string): Promise<boolean> => {
    const id = nodeRef.current;
    const text = answer.trim();
    if (!text || !canEdit) return false;
    let added = insertion(text);
    let done = insertIntoNoteEditor(id, added, { endIfNoCaret: true });
    if (!done) {
      done = (await drafts.editText(id, (body) => { added = additionAtEnd(body, text); return body + added; })) === "applied";
    }
    if (!done) { addToast(t("Open the note in the editor to put the answer in."), "info"); return false; }
    lastInsert.current = { nodeId: id, added };
    addToast(t("Put into the note."), "success", { label: t("Undo"), onClick: () => { void undoInsert(); } });
    return true;
  }, [canEdit, undoInsert]);

  return {
    entry, options, pick, setPick, roles: options?.roles ?? [], turns, loaded, live, busy, sending,
    chips, addScope, removeScope, text, setText, send, cancel, clear, decide, putIntoNote, undoInsert, reloadThread,
  };
}
