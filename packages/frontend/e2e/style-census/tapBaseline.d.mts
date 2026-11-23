export type TapCounts = Record<string, Record<string, { total: number; off: number }>>;
export const TAP_BASELINE_FILE: string;
export function readTapBaseline(file?: string): TapCounts;
export function compareTaps(base: TapCounts, measured: TapCounts): { ok: boolean; rows: { size: string; screen: string; before: number | null; after: number; total: number; grew: boolean }[] };
export function renderTapComparison(r: ReturnType<typeof compareTaps>): string;
export function writeTapBaseline(base: TapCounts, measured: TapCounts, file?: string): { lowered: number; added: number; kept: number };
