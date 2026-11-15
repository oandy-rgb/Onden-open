// Permanently deleting notes: the preview before and the answers after.
// Pure types: the app imports them with `import type`, so nothing here may run.

type TitledNode = { id: string; title: string };

/** What purgeDeleted would erase with `nodeId`, for the confirmation. */
export type PurgePreview = {
  node: TitledNode;
  /** The deleted notes under it, nearest first (its checklist items are
   *  counted in `tasks`, not listed). All go with it. */
  subtree: TitledNode[];
  tasks: number;
  /** Live notes under it. Any refuses the purge (409 live_descendant); D111
   *  keeps there being none. */
  live_descendants: TitledNode[];
  /** Uploaded files only these notes use, which go with them — images and
   *  other attachments — and files they use that another note still does,
   *  which stay. */
  media: { images: number; files: number; kept: number };
  /** Saved versions of their bodies (History), erased. */
  versions: number;
  /** Field values on them. */
  attributes: number;
  /** Every id that goes, the note first: pass back as `expected` so a purge
   *  never takes more than the confirmation showed. */
  ids: string[];
};

export type PurgeResult = {
  /** Rows hard-deleted (notes and their checklist items). */
  purged: number;
  /** Uploaded files removed. */
  media_removed: number;
};

export type PurgeItemResult =
  | { node_id: string; purged: true; media_removed: number }
  /** `code`: NodeTrashError.code (not_found, live_descendant, plan_changed …) or the AuthorityError reason. */
  | { node_id: string; purged: false; code: string };
