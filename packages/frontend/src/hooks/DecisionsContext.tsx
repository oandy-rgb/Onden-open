// What waits for the owner's decision, shared by the two places it is shown: the
// note's own line (components/NoteDecisions) and the inbox's 「等你決定」 section
// (modules/capture/DecideSection). One provider owns the queues, so both read the
// same live data and the same writers (useInboxSidebar → useInboxGovernance,
// useAttributeConflicts, propertyWriter.revertConflict, drafts.editText). Outside
// the provider (a lone editor in a test) nothing waits.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { addToast, selectOverviewNodes, useAppSelector } from "../lib/appStore";
import { drafts, propertyWriter } from "../lib/data";
import { resolveBodyConflict, type BodyConflictChoice, type BodyConflictRegion } from "../lib/bodyConflict";
import { t } from "../lib/i18n";
import { collectDecisions, type Decisions } from "../lib/decisions";
import type { SidebarInbox } from "./sidebarInboxTypes";
import { useAiEnabled } from "./useShellFeature";
import { useAttributeConflicts, useBodyConflicts } from "./useAttributeConflicts";

type Conflicts = ReturnType<typeof useAttributeConflicts>;

export type DecisionsValue = {
  inbox: SidebarInbox;
  fieldConflicts: Conflicts;
  bodyConflicts: ReturnType<typeof useBodyConflicts>;
  decisions: Decisions;
  onRevertFieldConflict: (eventId: number, nodeId: string, key: string) => Promise<boolean>;
  onResolveBodyConflict: (nodeId: string, region: BodyConflictRegion, choice: BodyConflictChoice) => Promise<boolean>;
  /** The inbox asked to open this note at its decision line (see NoteDecisions). */
  openRequest: string | null;
  requestOpenAt: (nodeId: string | null) => void;
};

const EMPTY_DECISIONS: Decisions = { byNote: new Map(), otherEvents: [], total: 0 };
const Ctx = createContext<DecisionsValue | null>(null);

/** Put a body conflict's left-out text into the note (lib/bodyConflict.ts),
 *  wherever the note is now: the open draft, or its saved body. False when
 *  the kept text was edited since, which the person then fixes by hand. */
async function resolveBody(nodeId: string, region: BodyConflictRegion, choice: BodyConflictChoice): Promise<boolean> {
  let found = true;
  const result = await drafts.editText(nodeId, (body) => {
    const next = resolveBodyConflict(body, region, choice);
    if (next === null) found = false;
    return next ?? body;
  });
  if (result === "applied" && found) return true;
  // "refused": the note writer has already reported it.
  if (result !== "refused") addToast(t("That part of the note has changed since. Open the note and edit it by hand."), "error");
  return false;
}

/** What an AI left waiting (its changes and held requests) is part of the AI feature: not listed while AI is off, kept on the server. */
const NO_AI_WAITING = { events: [], approvals: [], loadFailed: false } satisfies Pick<SidebarInbox, "events" | "approvals" | "loadFailed">;

export function DecisionsProvider({ inbox: fullInbox, children }: { inbox: SidebarInbox; children: ReactNode }) {
  const aiOn = useAiEnabled();
  const inbox = useMemo((): SidebarInbox => (aiOn ? fullInbox : { ...fullInbox, ...NO_AI_WAITING }), [aiOn, fullInbox]);
  const fieldConflicts = useAttributeConflicts();
  const bodyConflicts = useBodyConflicts();
  const nodes = useAppSelector(selectOverviewNodes);
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const requestOpenAt = useCallback((nodeId: string | null) => setOpenRequest(nodeId), []);
  const decisions = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return collectDecisions({
      events: inbox.events,
      heldRequests: inbox.approvals?.length ?? 0,
      fieldConflicts: fieldConflicts.conflicts,
      bodyConflicts: bodyConflicts.conflicts,
      hasNote: (id) => ids.has(id),
    });
  }, [inbox.events, inbox.approvals, fieldConflicts.conflicts, bodyConflicts.conflicts, nodes]);
  const value = useMemo((): DecisionsValue => ({
    inbox, fieldConflicts, bodyConflicts, decisions,
    onRevertFieldConflict: propertyWriter.revertConflict,
    onResolveBodyConflict: resolveBody,
    openRequest, requestOpenAt,
  }), [inbox, fieldConflicts, bodyConflicts, decisions, openRequest, requestOpenAt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The queues and writers, or null outside the provider. */
export function useDecisionsContext(): DecisionsValue | null {
  return useContext(Ctx);
}

/** How many things wait for the owner's decision (the inbox mark's count). */
export function useDecisionTotal(): number {
  return (useContext(Ctx)?.decisions ?? EMPTY_DECISIONS).total;
}
