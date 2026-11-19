// The event log's pure rules: the sentence for an event, which edits fold into
// one row, and the filter state — plus the workspace history screen's server
// calls (workspaceHistoryApi), the one part here that talks to the backend.
export { eventSentence, isMoveEvent, type SentenceContext } from "./eventSentence";
export { groupEvents, EDIT_GROUP_WINDOW_MS, type HistoryRow } from "./groupEvents";
export { activeFilters, clearFilter, NO_FILTERS, type ActorFilter, type ActiveFilter, type EventFilters } from "./eventFilters";
export { foldAgentCalls, isAgentToolEvent } from "./agentCalls";
export { openNoteHistory, subscribeNoteHistoryRequests, takeNoteHistoryRequest } from "./openNoteHistory";
// Paragraphs, their pairing and counts are @onden/markdown's one implementation (paragraphs.ts).
export { splitParagraphs, alignParagraphs, summarizeChange, type Paragraph, type Alignment, type ChangeSummary } from "@onden/markdown";
export { changeSummaryText, pointChangeText, inkChangeText, inkKindHeading } from "./changeSummaryText";
export { planTakeBack, type TakeBackPlan } from "./takeBack";
export {
  buildTimeline, initialIndex, scrubReducer, shown, authorKindOf, nearestIndex, tickIndexes, MAX_TICKS,
  type HistoryMarker, type NoteHistoryVersion, type ScrubAction, type ScrubState, type TimelinePoint, type AuthorKind,
} from "./noteTimeline";
// Who a history row says wrote it (one rule for every history reader).
export { historyAuthor, type HistoryAuthor, type HistoryAuthorTone } from "./historyAuthor";
// One paragraph's history (「這段的歷史」).
export { blockHistory, headingAbove, paragraphIndexAt, RAW_VERSION_LIMIT, type BlockSourceVersion, type BlockTarget, type BlockVersion } from "./blockHistory";
export { describeChange, type TextChange } from "./charDiff";
export * from "./workspaceHistoryApi";
export * from "./rewindApi";
