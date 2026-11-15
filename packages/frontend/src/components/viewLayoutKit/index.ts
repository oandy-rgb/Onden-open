// What a view module's layout (modules/table, kanban, calendar, gallery) draws
// with: row grouping and aggregates, the windowed row list, the built-in field
// names, and the calendar's month grid (also the 日記 page's month picker).
// A directory of its own, not part of components/collections, so a layout
// imports it without a cycle through CollectionView, which renders layouts.
export * from "./groupRows";
export * from "./useRowWindow";
export * from "./calendarGrid";
export { fieldDisplayName } from "./builtInFieldLabels";
