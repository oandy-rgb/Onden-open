export interface UnusedScan { files: Record<string, string>; exports: Record<string, string> }
export interface UnusedBaseline { intentional: UnusedScan; leftover: UnusedScan }
export const baselinePath: string;
export function moduleSpecifiers(text: string): Array<{ spec: string; glob: boolean }>;
export function declaredExports(text: string, fileName: string): string[];
export function scanUnused(root?: string): UnusedScan;
export function readBaseline(): UnusedBaseline;
export function compareUnused(current: UnusedScan, baseline?: UnusedBaseline): { ok: boolean; errors: string[] };
export function shrinkBaseline(current: UnusedScan, baseline?: UnusedBaseline): UnusedBaseline;
export function seedBaseline(current: UnusedScan, baseline?: UnusedBaseline): UnusedBaseline;
export function writeBaseline(baseline: UnusedBaseline): void;
