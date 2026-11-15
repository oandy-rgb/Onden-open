import type { CheckResult } from './dupLib.mjs';
export const THRESHOLD: number;
export interface NearFunction { name: string; start: number; end: number; tokens: string[]; file?: string }
export interface NearPair { a: NearFunction; b: NearFunction; similarity: number }
export interface NearScan { pairs: NearPair[]; current: Record<string, number> }
export function fingerprints(tokens: string[]): Set<number>;
export function functionsInSource(text: string, fileName?: string): NearFunction[];
export function findNearPairs(fns: NearFunction[], threshold?: number): NearPair[];
export function scanNearDuplicates(): NearScan;
export function writeNearBaseline(current: Record<string, number>): void;
export function describePair(p: NearPair): string;
export function compareNearDuplicates(scan: NearScan): CheckResult;
