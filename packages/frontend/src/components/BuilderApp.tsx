import { Suspense, useEffect, useState } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import { shouldSkipServerSetup, getApiBase } from "../lib/api";
import { verifiedAccountFor } from "../lib/accountStorage";
import { captureInviteFromUrl } from "../lib/invite";
import { rememberLoadedFiles } from "../lib/rememberLoadedFiles";
import LoginGate from "./LoginGate";
import { consumeCaptureArrival } from "../lib/captureArrival";
import BootScreen from "./BootScreen";
import { elementById } from "../lib/documentAccess";

// Everything before sign-in is in this file's static imports: server setup,
// LoginGate and the auth client. The workspace (BuilderWorkspace and its
// ~40 hooks/components, the data layer, the app store) is its own chunk,
// fetched only once it may be needed: see prefetchWorkspace.
const loadWorkspace = () => import("./BuilderWorkspace").then((chunk) => {
  // Offline warm boot needs this chunk in the service worker's cache: see
  // lib/rememberLoadedFiles.ts.
  rememberLoadedFiles();
  return chunk;
});
const BuilderWorkspace = lazyWithReload(loadWorkspace);
const ServerSetup = lazyWithReload(() => import("./ServerSetup"));

/** Start downloading the workspace chunk without waiting for the session
 *  check. Only a device that was signed in here before does it (the verified
 *  account hint, lib/accountStorage): its session check will most likely
 *  succeed, so the chunk arrives in parallel with it instead of after it.
 *  A first visit or a signed-out device keeps the login page light. The hint
 *  is not trusted for anything else: LoginGate still decides what renders. */
function prefetchWorkspace(): void {
  if (verifiedAccountFor(getApiBase()) !== null) void loadWorkspace().catch(() => {});
}

/** The page-level mount below the error boundary: server setup, then sign-in,
 *  then the lazily loaded workspace. */
export default function BuilderApp() {
  useEffect(() => {
    elementById("app-initial-loading")?.remove();
    prefetchWorkspace();
  }, []);

  // Lazy initializer: read-and-strip exactly once, surviving the setup/login
  // gates below (the URL is already clean by the time the workspace mounts).
  const [{ share: sharedDraft, open: openCapture }] = useState(consumeCaptureArrival);
  // An invite link (`?invite=…`, D110) is read the same way, before the URL
  // canonicaliser runs: LoginGate carries it through sign-up and claims it.
  useState(captureInviteFromUrl);

  const isNative = import.meta.env.VITE_NATIVE === "true";

  // No server-URL wall for the common case. When the page is served in a
  // browser, same-origin /api (getApiBase() === "" → no prefix) is the
  // intended docker-compose-behind-nginx default, so we're ready immediately.
  // ServerSetup is now an OPT-IN "connect to a different server" path, not a
  // first-screen jargon gate — it only mounts when a user explicitly asks for
  // it (setReady(false)), never just because PUBLIC_API_BASE_URL wasn't baked
  // at build time.
  const [ready, setReady] = useState(() =>
    shouldSkipServerSetup({
      isNative,
      hasBuiltInBase: import.meta.env.PUBLIC_API_BASE_URL !== undefined,
    })
  );

  // Server URL must come first (you can't authenticate without a backend),
  // then sign-in, on the web and in the native app alike: LoginGate binds the
  // account that scopes the local store and names every request. No storage
  // question is asked: notes live on this device by default, and a folder
  // copy is opt-in in Settings (lib/localBackup).
  if (!ready) return <Suspense fallback={<BootScreen />}><ServerSetup onConnect={() => setReady(true)} /></Suspense>;
  return (
    <LoginGate>
      <Suspense fallback={<BootScreen />}>
        <BuilderWorkspace sharedDraft={sharedDraft} openCapture={openCapture} />
      </Suspense>
    </LoginGate>
  );
}
