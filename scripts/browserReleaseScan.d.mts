export interface Finding { kind: "key" | "url" | "ip" | "email" | "path"; label: string; match: string; line: number }
export function scanText(text: string): Finding[];
export function scanFolder(folder: string, resolveDependency?: (spec: string) => string): { scanned: number; findings: Array<Finding & { file: string }> };
export const VENDORED: Record<string, string>;
export function isVendoredCopy(relativePath: string, bytes: Uint8Array, resolveDependency?: (spec: string) => string): boolean;
export function reportFindings(result: { scanned: number; findings: Array<Finding & { file: string }> }, write?: (line: string) => void): void;
export function notPublished(relativePath: string): boolean;
