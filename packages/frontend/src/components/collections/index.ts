// The saved-view collection surface (list / table / kanban / calendar /
// gallery over a tag's members). Import from "components/collections".
export type { SavedView } from "./CollectionView";
export { layoutNames, paramOptions } from "./paramOptions";
export { default as LayoutChooser, layoutChoices, missingFieldHint, placementChanges } from "./LayoutChooser";
export type { LayoutChoice, LayoutParam } from "./LayoutChooser";
export { viewNameParts } from "./viewNames";
// The view editor loads when a person first edits a view's filters; lib/offlineWarmup.ts fetches it ahead.
// A saved view's rows load when such a view opens, not at boot (lib/offlineWarmup.ts fetches them ahead).
export const loadCollectionView = () => import("./CollectionView");
export const loadViewBuilder = () => import("./ViewBuilder");
