import { Buffer as B } from "buffer";
export const Buffer = B;
export const process = {
  env: { NODE_ENV: "development", LOG_LEVEL: "warn", BETTER_AUTH_URL: "http://localhost" },
  cwd: () => "/", argv: [], platform: "browser", versions: {}, version: "v22.0.0",
  nextTick: (f, ...a) => queueMicrotask(() => f(...a)), on() {}, off() {}, emitWarning() {}, memoryUsage: () => ({ rss: 0 }), hrtime: () => [0, 0], stdout: { write() {} }, stderr: { write() {} },
};
