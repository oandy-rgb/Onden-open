// The package's one entry. The app reaches this file through a Vite alias, which
// marks it as having import-time side effects (package.json "sideEffects": false
// only reaches files imported relatively), so it must hold no third-party
// imports: they would stay in the boot JS even when unused. Everything is in
// core.ts, which Rollup can drop piece by piece.
export * from "./core.js";
