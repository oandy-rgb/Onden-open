import type { BootFailureKind } from "@onden/markdown";

// Whether a saved copy can be opened by this build, decided from the migrations the copy has and the ones this
// build carries (docs/architecture/browser-app.md §3). Pure, so the rule is testable without a database.
//
//   • The copy has a migration this build does not know → the copy is NEWER than the app (another tab or device ran a
//     newer version, or a cached old build was opened): opening it would run old code on a schema it does not
//     understand and the next save would overwrite the newer copy. Refuse and say so; nothing is changed.
//   • The build has migrations the copy lacks → upgrade: run them on the in-memory database, and only a successful
//     run is followed by a save (the old copy stays until the store has the new one).

export type SchemaVerdict =
  | { kind: "current" }
  | { kind: "upgrade"; pending: string[] }
  | { kind: "newer"; unknown: string[] };

export function judgeSchema(applied: readonly string[], bundled: readonly string[]): SchemaVerdict {
  const known = new Set(bundled);
  const unknown = applied.filter((version) => !known.has(version));
  if (unknown.length > 0) return { kind: "newer", unknown };
  const have = new Set(applied);
  const pending = bundled.filter((version) => !have.has(version));
  return pending.length > 0 ? { kind: "upgrade", pending } : { kind: "current" };
}

/** An Error that says why the start failed (worker.ts boot → the page's explanation). */
export function bootFailure(kind: BootFailureKind, message: string): Error & { bootFailureKind: BootFailureKind } {
  return Object.assign(new Error(message), { bootFailureKind: kind });
}

export function bootFailureKind(error: unknown): BootFailureKind {
  const kind = (error as { bootFailureKind?: BootFailureKind } | null)?.bootFailureKind;
  return kind ?? "other";
}
