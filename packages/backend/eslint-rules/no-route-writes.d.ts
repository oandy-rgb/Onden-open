// Types for the plain-JS lint rule, so src/test/routeWrites.test.ts can import its helpers.
export declare const ALLOWLIST: Record<string, string>;
export declare function isRouteFile(rel: string): boolean;
export declare function sqlWriteIn(text: string): string | null;
declare const rule: unknown;
export default rule;
