// When the running build was made (epoch ms), stamped at build time (astro.config.mjs,
// vite.browser.config.ts, vite.capacitor.config.ts: `__ONDEN_BUILT_AT__`). Null where nothing
// stamps it (unit tests, scripts): callers treat that as "unknown", never as "now".
// Kept apart from lib/lazyWithReload's BUILD_ID, which is an opaque id (a git sha, a tag), not a time.

declare const __ONDEN_BUILT_AT__: number | undefined;
export const BUILT_AT_MS: number | null = typeof __ONDEN_BUILT_AT__ === "number" ? __ONDEN_BUILT_AT__ : null;
