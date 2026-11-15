// Focus sessions of the tasks module.
// Pure types: the app imports them with `import type`, so nothing here may run.

export type FocusSession = {
  id: string;
  task_id: string | null;
  started_at: string;
  /** null while it runs. */
  ended_at: string | null;
  note: string;
};
