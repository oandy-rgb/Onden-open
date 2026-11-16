export const SKIP_PHRASE: string;
export interface DiffEntry { status: string; path: string }
export function isUserFacingSource(path: string): boolean;
export function checkChanges(entries: DiffEntry[]): { ok: boolean; touched: string[]; added: string[] };
export function diffEntries(base?: string): DiffEntry[];
export function skipRequested(argv: string[], env: Record<string, string | undefined>): boolean;
export function isTestPath(path: string): boolean;
