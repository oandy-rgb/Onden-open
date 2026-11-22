export const CARD_HEADING: string;
export const CARD_FIELDS: string[];
export const CARD_REQUIRED_FROM: string;
export const DEVICE_PATHS: RegExp[];
export function readCard(body: string | null | undefined): Record<string, string> | null;
export function cardProblems(body: string | null | undefined, changedPaths?: string[]): string[];
export function cardRequired(createdAt: unknown): boolean;
