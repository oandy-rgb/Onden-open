// A page of rows with the cursor to the next.
// Pure types: the app imports them with `import type`, so nothing here may run.

/** One page of a list. `next` = the offset of the next page, null at the end. */
export type Page<T> = { rows: T[]; total?: number; next: number | null };
