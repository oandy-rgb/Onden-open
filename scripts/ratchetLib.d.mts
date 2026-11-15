export interface RatchetResult { ok: boolean; errors: string[]; notes: string[] }
export function runRatchet(options?: { cwd?: string; mainRef?: string }): RatchetResult;
export function compareGroups(base: Map<string, Map<string, number>>, current: Map<string, Map<string, number>>, headText?: (file: string) => string | null): string[];
export function jsonGroups(file: string, text: string): Map<string, Map<string, number>>;
export function tsGroups(file: string, text: string): Map<string, Map<string, number>>;
export function resolveBase(cwd: string, mainRef?: string): { base: string } | { fail: string };
export const OVERRIDE: RegExp;
