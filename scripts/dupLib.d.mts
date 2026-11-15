export const root: string;
export const OWNER_HINT: string;
export interface DupCounts { clones: number; duplicatedLines: number }
export interface DupScan { current: DupCounts; duplicates: { lines: number; where: string }[] }
export interface CheckResult { ok: boolean; errors: string[]; notes: string[] }
export function scanDuplicates(): DupScan;
export function writeDupBaseline(current: DupCounts): void;
export function compareDuplicates(scan: DupScan): CheckResult;
export function exportedValueNames(text: string, fileName?: string): Set<string>;
export function exportedTypeNames(text: string, fileName?: string): Set<string>;
/** names: 同名函式／常數；types: 前後端各自定義的同名 type／interface。 */
export type DuplicateNames = { names: Record<string, string[]>; types: Record<string, string[]>; typesAllowedSeen?: string[] };
export function scanDuplicateNames(rootDir?: string): DuplicateNames;
export function writeNamesBaseline(current: DuplicateNames): void;
export function compareDuplicateNames(current: DuplicateNames): CheckResult;
export const TEST_HELPER_DIRS: string[];
export function productSourceFiles(): string[];
