import type { Catalog } from "./entrypointsCatalog.mjs";
export const root: string;
export const BASELINE_FILE: string;
export const RATCHET_RULES: Set<string>;
export type WriteMode = "off" | "lower" | "init";
export interface RuleMeta { what: string; owner?: string }
export interface RuleResult { ok: boolean; errors: string[]; notes: string[] }
export function writeMode(): WriteMode;
export function readBaseline(file?: string): Record<string, Record<string, number>>;
export function compareToBaseline(rule: string, actual: Record<string, number>, meta: RuleMeta, baseline?: Record<string, Record<string, number>>, catalog?: Catalog): RuleResult;
export function lowerBaseline(rule: string, actual: Record<string, number>, mode?: WriteMode, file?: string): void;
export function checkRule(rule: string, actual: Record<string, number>, meta: RuleMeta): RuleResult;
export function countByFile(files: string[]): Record<string, number>;
