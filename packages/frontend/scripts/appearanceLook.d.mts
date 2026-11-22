export interface Look { kind: string; rule: string; raw: string[] }
export interface Where { selector?: string; inFontFace?: boolean }
export const LOOK_RULES: Record<string, string[]>;
export const CSS_LOOK_RULES: string[];
export const TSX_LOOK_RULES: string[];
export function withoutVars(value: string): string;
export function isControlSelector(selector: string): boolean;
export function declarationLooks(prop: string, value: string, where?: Where): Look[];
export function declarationContext(decl: { parent?: { type: string; name?: string; selector?: string } | undefined }): Where;
export function stylesheetLooks(source: string, from?: string): (Look & { prop: string; line: number; usesToken: boolean })[];
export const ICON_SIZE_LEVELS: number[];
export const ICON_STROKE_LEVELS: number[];
export function iconLooks(path: string, source: string): (Look & { line: number; off: boolean })[];
export function exemptedRules(decl: import("postcss").Declaration): Set<string>;
