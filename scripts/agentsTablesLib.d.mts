export const root: string;
export const START: string;
export const END: string;
export const TARGETS: Record<string, () => string>;
export function withBlock(text: string, block: string): string | null;
export function expectedFiles(): { file: string; current: string; expected: string | null }[];
export function writeAll(): string[];
