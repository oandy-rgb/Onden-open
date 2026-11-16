export const REMOVED_PATHS_FILE: string;
export interface RemovedRules { files: string[]; prefixes: string[]; imagesUnder: string[]; imageExtensions: string[] }
export function loadRemovedRules(root: string, opts?: { required?: boolean }): RemovedRules;
export function isRemovedPath(rules: RemovedRules, path: string): boolean;
export function linkPattern(rules: RemovedRules): string;
