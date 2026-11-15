export const NO_DATABASE_FLAG: string;
export class SkipGateReporter {
  constructor(options: {
    strict?: "all" | "gated";
    isGated: (file: string, text: string) => boolean;
    expected?: { pglite?: Record<string, number>; postgres?: Record<string, number> };
  });
  onInit(ctx: unknown): void;
  onTestRunEnd(testModules: ReadonlyArray<any>, unhandledErrors: ReadonlyArray<unknown>, reason: string): void;
}
