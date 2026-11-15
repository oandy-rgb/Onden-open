// Boot wiring for lazyWithReload: listen for Vite's preload failures. bootApp
// (bootApp.ts) calls it, so every entry that mounts AppRoot installs it.
//
// The draft check before a reload (wait for started saves, send the pending
// draft, find out whether any text lives only in memory) is registered by
// lib/data/draftActions.ts when the data layer loads. It used to be imported
// here at reload time, but after a deploy that import asks for files the
// server no longer has, so every reload was blocked. The sign-in page never
// loads the data layer, has no draft, and keeps the default "safe".

import { installChunkReloadHandler } from "./lazyWithReload";

export function installStaleChunkReload(): void {
  installChunkReloadHandler();
}
