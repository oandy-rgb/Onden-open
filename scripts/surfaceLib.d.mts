export const SURFACE_FILE: string;
export function checkSurface(key: string, actual: number, what: string, file?: string, mode?: string): { ok: boolean; errors: string[]; notes: string[] };
