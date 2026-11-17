import type { RemovedRules } from "./public-mirror/removedPaths.mjs";
export const BASELINE_FILE: string;
export const SKIP_DOCS_PHRASE: string;
export const SUPERSEDED_FILE: string;
export interface SupersededEntry { paths: string[]; replacedBy: string; pr: string }
export interface DocHead { status: string | null; statusLine: string | null; generated: boolean; confirmed: string | null; after: string | null; covers: string[]; headText: string }
export interface Problem { f?: string; line: number; message: string }
export interface DiffEntry { status: string; path: string }
export function needsStatusLine(f: string): boolean;
export function parseHead(text: string): DocHead;
export function listFiles(root: string): string[];
export function checkLinks(root: string, f: string, text: string): Problem[];
export function checkStatus(root: string, f: string, head: DocHead, files: Set<string>): Problem[];
export function lastTouched(root: string, f: string): string | null;
export function proposalDate(f: string, head: DocHead, touched?: string | null): { date: string | null; source: string | null };
export function oldProposals(docs: { f: string; head: DocHead; touched?: string | null }[], now?: Date): { f: string; date: string | null; source: string | null; age: number | null; after: string | null }[];
export function loadSuperseded(root: string): SupersededEntry[];
export function checkCodeRefs(root: string, f: string, text: string, files: string[] | Set<string>, ctx?: { superseded?: SupersededEntry[]; removed?: RemovedRules | null }): Problem[];
export function removedByMirror(root: string, rules: RemovedRules, path: string): boolean;
export function wantsCodeRefs(f: string, head: DocHead): boolean;
export function globToRegExp(glob: string): RegExp;
export function matchesAny(globs: string[], path: string): boolean;
export function checkCovers(head: DocHead, files: string[], superseded?: SupersededEntry[]): Problem[];
export function uncoveredChanges(docs: { f: string; head: { covers: string[] } }[], entries: DiffEntry[]): { doc: string; globs: string[]; files: string[] }[];
export function docsSkipReasons(env: Record<string, string | undefined>, messages?: string[]): string[];
export function implementedProposals(env: Record<string, string | undefined>, messages?: string[]): string[];
export function docsSkipRequested(argv: string[], env: Record<string, string | undefined>, messages?: string[]): boolean;
export function baselineValue(root: string, ref: string): number | undefined;
export function checkNumbers(root: string, text: string): Problem[];
export interface CheckResult {
  problems: Record<"links" | "status" | "codeRefs" | "covers" | "numbers" | "exceptions", Problem[]>;
  docs: { f: string; head: DocHead }[];
  counts: { documents: number; codeRefDocuments: number; byStatus: Record<string, number> };
  total: number;
  oldProposals: ReturnType<typeof oldProposals>;
  exceptions: Record<string, string>;
  noCoverage: string[];
  coversNothing: Array<{ f: string; reason: string }>;
  superseded: SupersededEntry[];
}
export function checkDocs(root: string, opts?: { files?: string[]; baseline?: { codeReferences?: Record<string, string>; noCoverage?: string[] }; now?: Date; superseded?: SupersededEntry[]; removed?: RemovedRules }): CheckResult;
export function summary(r: CheckResult): string;
export function coveredCheck(root: string, opts?: { base?: string; argv?: string[]; env?: Record<string, string | undefined> }): { code: number; lines: string[] };
