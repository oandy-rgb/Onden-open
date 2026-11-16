// Two focus sessions of one person that are both still running (4.4, decision A): both stay; the earlier one is taken
// to have ended when the next one began, so time is not counted twice. A view, like names.ts: the data keeps `end = null`.
export type FocusSession = { id: string; actor: string; startedAt: number; endedAt: number | null };
export type FocusFix = { id: string; endedAt: number };

/** The sessions whose end has to be shown as the start of the next running one. Several running at once chain: each ends when the next starts. */
export function resolveRunningFocus(sessions: readonly FocusSession[]): FocusFix[] {
  const fixes: FocusFix[] = [];
  const byActor = new Map<string, FocusSession[]>();
  for (const s of sessions) if (s.endedAt === null) byActor.set(s.actor, [...(byActor.get(s.actor) ?? []), s]);
  for (const [, running] of byActor) {
    running.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    running.slice(0, -1).forEach((s, i) => fixes.push({ id: s.id, endedAt: running[i + 1]!.startedAt }));
  }
  return fixes.sort((a, b) => (a.id < b.id ? -1 : 1));
}
