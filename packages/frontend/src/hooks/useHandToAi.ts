import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addToast } from "../lib/appStore";
import { getApiBase } from "../lib/api";
import { drafts, onlineOperation, reads } from "../lib/data";
import { t } from "../lib/i18n";
import { randomUUID } from "../lib/uuid";
import { isOpenSession, type AgentSessionBrief } from "../lib/agentMentions";
import {
  chooseTarget, entryState, offeredActions, targetLine, usableRoles,
  type HandOptions, type HandPick, type HandRun, type HandTarget,
} from "../lib/handToAi";
import { useNoteSkills } from "./useNoteSkills";

const POLL_MS = 3_000;
/** How long a finished card stays before it goes away on its own. */
const DONE_LINGER_MS = 2_500;

export type HandStart = {
  /** A built-in skill id (the ready-made actions) or one of the person's skill notes. */
  skill: string; skillName: string;
  /** Exactly the characters to replace: the selection, or the paragraph. */
  text: string;
  /** A sentence for this once (the 「自訂…」 box); never stored. */
  instruction?: string;
  /** Where the card goes: a viewport point near the text. */
  at: { x: number; y: number };
};

/** 「交給 AI」 for the open note: which actions and roles exist, the pick for this
 *  once, and the one request in flight. Starting goes through the online write path
 *  (the same request id sent again is the same session, so a lost reply does not
 *  start it twice) after the note itself is saved, because the server finds the
 *  selected words in the saved note. The result is a pending suggestion, shown by
 *  the suggestion bar once `onDone` has it read again. Nothing says "done" before
 *  the server did. */
export function useHandToAi({ nodeId, canEdit, online, onDone }: {
  nodeId: string | undefined; canEdit: boolean; online: boolean; onDone: () => void;
}) {
  const skills = useNoteSkills({ autoload: false, online });
  const [options, setOptions] = useState<HandOptions | null>(null);
  const [pick, setPick] = useState<HandPick>({});
  const [run, setRun] = useState<(HandRun & { at: { x: number; y: number } }) | null>(null);
  const nodeRef = useRef(nodeId);
  nodeRef.current = nodeId;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const lastRef = useRef<HandStart | null>(null);
  const tokenRef = useRef(0);
  const stopRef = useRef<() => void>(() => {});

  const leave = useCallback(() => { stopRef.current(); stopRef.current = () => {}; }, []);
  // A different note: nothing of the last one is kept (a request already sent still ends as a suggestion on its note).
  useEffect(() => { leave(); setOptions(null); setPick({}); setRun(null); }, [nodeId, leave]);
  useEffect(() => leave, [leave]);

  /** Look up the roles and skills; called when the menu opens. */
  const load = useCallback(async () => {
    const id = nodeRef.current;
    if (!id || !online) return;
    void skills.refresh();
    try {
      const body = await reads.aiRuntime.handToAi<HandOptions>(id);
      if (nodeRef.current === id) setOptions(body);
    } catch { if (nodeRef.current === id) setOptions(null); }
  }, [online, skills]);

  const target: HandTarget | null = useMemo(() => chooseTarget(options, pick), [options, pick]);
  const entry = useMemo(() => entryState({ canEdit, online, options }), [canEdit, online, options]);
  const actions = useMemo(() => offeredActions(skills.catalogue), [skills.catalogue]);
  const noteSkills = skills.skills ?? [];

  const update = useCallback((token: number, change: Partial<HandRun>) => {
    setRun((current) => (current && current.token === token ? { ...current, ...change } : current));
  }, []);

  const finish = useCallback((token: number, status: string, failCode: string | null) => {
    leave();
    if (status === "completed") {
      update(token, { phase: "done" });
      doneRef.current();
      window.setTimeout(() => setRun((current) => (current && current.token === token && current.phase === "done" ? null : current)), DONE_LINGER_MS);
    } else if (status === "cancelled") update(token, { phase: "cancelled", failCode });
    else update(token, { phase: "failed", failCode });
  }, [leave, update]);

  /** API: the answer as it is written, through one stream. */
  const follow = useCallback((token: number, sessionId: string) => {
    const source = new EventSource(`${getApiBase()}/api/ai/selection-actions/${sessionId}/stream`, { withCredentials: true });
    let ended = false;
    source.onmessage = (message) => {
      let frame: { kind?: string; text?: string; status?: string; fail_code?: string | null };
      try { frame = JSON.parse(message.data); } catch { return; }
      if (frame.kind === "text" && typeof frame.text === "string") {
        const delta = frame.text;
        setRun((current) => (current && current.token === token ? { ...current, phase: "streaming", text: current.text + delta } : current));
      } else if (frame.kind === "end") {
        ended = true;
        source.close();
        finish(token, frame.status ?? "failed", frame.fail_code ?? null);
      }
    };
    // A dropped connection: the browser retries by itself and the server replays what was written.
    source.onerror = () => { if (!ended && source.readyState === EventSource.CLOSED) finish(token, "failed", "api_unreachable"); };
    stopRef.current = () => source.close();
  }, [finish]);

  /** Subscription / MCP: nothing streams, so the request's status is looked at again. */
  const poll = useCallback((token: number, sessionId: string) => {
    const look = async () => {
      try {
        const body = await reads.agentMentions.session<AgentSessionBrief>(sessionId);
        const session = body.session;
        update(token, { session, phase: "waiting" });
        if (!isOpenSession(session.status)) finish(token, session.status, session.fail_code);
      } catch { /* offline for a moment: the card keeps what it knew */ }
    };
    void look();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void look(); }, POLL_MS);
    stopRef.current = () => window.clearInterval(timer);
  }, [finish, update]);

  const start = useCallback(async (input: HandStart): Promise<boolean> => {
    const id = nodeRef.current;
    if (!id || !target || entry.blocked) return false;
    leave();
    lastRef.current = input;
    const token = ++tokenRef.current;
    const line = targetLine(target);
    setRun({ token, skillName: input.skillName, line, runtime: target.runtime, phase: "starting", text: "", sessionId: null, failCode: null, session: null, at: input.at });
    try {
      // The server finds the selected words in the saved note.
      if (!(await drafts.flush())) {
        addToast(t("The note couldn't be saved, so nothing was sent. Your text is kept."), "error");
        setRun(null);
        return false;
      }
      const requestId = randomUUID();
      const result = await onlineOperation(`hand-to-ai:${id}:${requestId}`, t("Handing to the AI needs a connection."), (submit) => submit<{ session_id: string }>(
        "/api/ai/selection-actions",
        JSON.stringify({
          agent_actor_id: target.role.actor_id, node_id: id, skill: input.skill, text: input.text, request_id: requestId,
          runtime: target.runtime, ...(input.instruction ? { instruction: input.instruction } : {}),
        })));
      if (tokenRef.current !== token) return false;
      if ("deduped" in result) { setRun(null); return false; }
      update(token, { sessionId: result.session_id, phase: target.runtime === "api" ? "streaming" : "waiting" });
      if (target.runtime === "api") follow(token, result.session_id); else poll(token, result.session_id);
      return true;
    } catch {
      // The online write path already told the person why.
      if (tokenRef.current === token) setRun(null);
      return false;
    }
  }, [target, entry.blocked, leave, update, follow, poll]);

  const cancel = useCallback(async () => {
    const current = run;
    if (!current?.sessionId) { tokenRef.current++; leave(); setRun(null); return; }
    try {
      await onlineOperation(`hand-to-ai-cancel:${current.sessionId}`, t("Cancelling needs a connection."),
        (submit) => submit(`/api/agent-sessions/${current.sessionId}/cancel`));
      finish(current.token, "cancelled", "cancelled_by_user");
    } catch { /* told already; the request keeps running */ }
  }, [run, leave, finish]);

  const retry = useCallback(() => { const last = lastRef.current; if (last) void start(last); }, [start]);
  const dismiss = useCallback(() => { tokenRef.current++; leave(); setRun(null); }, [leave]);

  return {
    entry, actions, noteSkills, options, roles: usableRoles(options), target, pick, setPick, load,
    run, start, cancel, retry, dismiss,
  };
}

export type HandToAi = ReturnType<typeof useHandToAi>;
