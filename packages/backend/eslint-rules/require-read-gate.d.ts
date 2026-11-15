// Types for the require-read-gate eslint rule's shared classification maps,
// consumed by src/test/readGuard.test.ts so the lint and the vitest backstop
// classify from one source of truth.
export declare const READ_GATE: {
  GATED: Record<string, RegExp>;
  INTERNAL: Record<string, string>;
  DEFERRED: Record<string, string>;
  /** Typed-builder (Kysely) readers that serve notes: the read-policy primitive each must reference. */
  TYPED_GATED: Record<string, RegExp>;
  readsNodes: (src: string) => boolean;
  /** domain_events readers: RegExp = primitive the file must reference; string = why it is not served. */
  EVENT_READS: Record<string, RegExp | string>;
  readsEvents: (src: string) => boolean;
  /** The file USES the primitive (a call or a read of it), not just names it in an import or a comment. */
  usesGate: (src: string, claimed: RegExp) => boolean;
};
declare const rule: unknown;
export default rule;
