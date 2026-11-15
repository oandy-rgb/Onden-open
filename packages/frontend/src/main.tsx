import { createRoot } from "react-dom/client";
import AppRoot from "./AppRoot";
import "./styles/global.css";
import "./styles/input-font.css";
// The app's faces. This entry runs from local files (dev server, Capacitor),
// so a static import costs no network; the web entry loads it lazily
// (pages/index.astro).
import "./styles/fonts-noto.css";

// The Vite entry (dev server and the Capacitor app). It mounts the same root as
// the web build's index.astro; page-level setup is bootApp's (bootApp.ts),
// run by AppRoot, so nothing is added here.
createRoot(document.getElementById("root")!).render(<AppRoot />);
