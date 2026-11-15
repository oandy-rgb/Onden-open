import "./temporaryEntry"; // first: a temporary session replaces the page's storage before anything else loads
import { createRoot } from "react-dom/client";
import BrowserAppShell from "./BrowserAppShell";
import { elementById } from "../lib/documentAccess";
import "../styles/global.css";
import "../styles/input-font.css";

// Entry of the browser app (browser.html, vite.browser.config.ts). It mounts the same AppRoot as the web build
// and the Capacitor app, after the worker is up and /api is bridged to it (BrowserAppShell).
createRoot(elementById("root")!).render(<BrowserAppShell />);
