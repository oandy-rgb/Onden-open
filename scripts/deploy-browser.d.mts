export interface DeployOptions { to?: string; path?: string; tag?: string; from?: string; build?: boolean; dryRun?: boolean; reportUrl?: string }
export function parseArgs(argv: string[]): DeployOptions;
export function safeSegment(value: string, what: string): string;
export function targetFolder(to: string, subPath?: string, tag?: string): { base: string; target: string };
export function deploy(options: DeployOptions, log?: (line: string) => void): { target: string; copied: number };
