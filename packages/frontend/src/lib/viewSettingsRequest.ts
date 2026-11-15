// 「再做一個不同的…」 makes a copy and wants its own settings open on arrival,
// before the person has typed anything: the tab row asks, the view's page
// (CollectionView) takes the request once it shows that view. Kept for one
// view id only, so a request for a view that never opens cannot open another.

let requested: string | null = null;

export function requestViewSettings(viewId: string): void {
  requested = viewId;
}

/** True once for the view that was asked for. */
export function takeViewSettingsRequest(viewId: string): boolean {
  if (requested !== viewId) return false;
  requested = null;
  return true;
}
