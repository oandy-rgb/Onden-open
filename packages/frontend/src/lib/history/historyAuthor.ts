// Who a history row says wrote it: ONE rule for a note's versions, its drawings' edits and one paragraph's history
// (NoteHistory, BlockHistorySheet). The server sends a kind and a name (packages/backend/src/services/authorName.ts):
// a temporary session has the kind 'session' and no name; an author this node holds no row for (a removed member)
// has the kind its event recorded and no name.
//
// 「你」 only for a person whose name is the signed-in account's name. An author with no name is never "you": that is
// exactly the session and the removed member, and calling either "you" puts their edit on the reader. Two members
// who share a name both read as "you" to each other; the readers send no author id to tell them apart (the
// contract's HistoryActor) — the same rule the day list uses (WorkspaceHistoryNoteRow).

import { t } from "../i18n";
import { agentLabel } from "../actorLabel";
import type { AuthorKind } from "./noteTimeline";

export type HistoryAuthorTone = "agent" | "system" | "session" | "self" | "member";

export type HistoryAuthor = { text: string; tone: HistoryAuthorTone };

/** `selfName`: the signed-in account's name (null before the account is known: nobody is "you" then). */
export function historyAuthor(kind: AuthorKind, name: string | null, selfName: string | null): HistoryAuthor {
  if (kind === "agent") return { text: agentLabel(name), tone: "agent" };
  if (kind === "system") return { text: t("Automatic"), tone: "system" };
  if (kind === "session") return { text: t("A temporary session"), tone: "session" };
  if (name && selfName !== null && name === selfName) return { text: t("You"), tone: "self" };
  return { text: name || t("Someone"), tone: "member" };
}
