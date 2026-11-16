export type LicencePolicy = { allowed: string[]; conditional: Record<string, { how: string; packages: string[] }> };
export function allows(policy: LicencePolicy, licence: string, name: string): boolean;
