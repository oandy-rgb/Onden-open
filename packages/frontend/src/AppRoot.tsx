import AppErrorBoundary from "./components/AppErrorBoundary";
import BuilderApp from "./components/BuilderApp";
import { bootApp } from "./bootApp";

// Both entries mount this: index.astro (web, client:only) and main.tsx
// (Vite dev and the Capacitor app). Page-level setup lives in bootApp, which
// runs once when this module loads, before either entry renders.
bootApp();

// The page-level mount: BuilderApp (server setup, then sign-in, then the
// workspace) inside the last-resort error boundary, so a render crash anywhere
// in the tree shows the fallback instead of a white screen.
export default function AppRoot() {
  return (
    <AppErrorBoundary>
      <BuilderApp />
    </AppErrorBoundary>
  );
}
