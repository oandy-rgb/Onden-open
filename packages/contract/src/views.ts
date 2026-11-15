// A row of a collection view as the server runs it.
// Pure types: the app imports them with `import type`, so nothing here may run.

export interface ExecRow {
  id: string;
  title: string;
  slug: string;
  /** ISO 8601 instants (e.g. 2026-10-21T03:00:00.120Z), both. */
  created_at: string;
  updated_at: string;
  attributes: Record<string, string | null>;
}

/** `layout_config_patch` of PATCH .../views/:viewId: the keys of a view's `layout_config` to change, and nothing
 *  else. A value sets the key (the whole value of that key, not a merge inside it); `null` removes the key. Keys
 *  not named are left as the server has them, so two devices changing different settings of one whiteboard
 *  (tree, card display, folds, hidden…) do not overwrite each other; the same key from two devices is last
 *  write wins. Send either this or the whole-object `layout_config` (older clients, backup restore), not both. */
export type LayoutConfigPatch = Record<string, unknown>;
