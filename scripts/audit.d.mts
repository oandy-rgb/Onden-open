export function advisories(report: unknown): Map<string, string>;
export function compare(actual: Map<string, string>, baseline: Record<string, string>): { added: [string, string][]; gone: string[] };
