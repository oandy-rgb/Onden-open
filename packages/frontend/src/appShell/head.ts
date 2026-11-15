// The <head> every page that boots the app shares, as data. Three hand-written shells used to repeat it and drift
// (#1400 added `interactive-widget=resizes-content` to index.html only, so the phone never got it until #1412):
//   - "web":       src/pages/index.astro, what production serves (Astro build and dev), via AppHead.astro
//   - "capacitor": index.html, the Android app (vite.capacitor.config.ts)
//   - "browser":   browser.html, the browser trial (vite.browser.config.ts)
// The Vite shells put `APP_HEAD_PLACEHOLDER` where the head goes and `appHeadPlugin` (./vitePlugin.ts) fills it.
// Anything that differs per shell is an option below with its reason; shell-specific scripts and boot paint stay in the shell.
// This file must stay free of imports: the Vite configs load it.

export type AppShell = "web" | "capacitor" | "browser";

export type HeadEntry =
  | { tag: "meta"; attrs: Record<string, string> }
  | { tag: "link"; attrs: Record<string, string> }
  | { tag: "title"; text: string };

interface ShellOptions {
  title: string;
  description: string;
  /** `viewport-fit=cover` lets the page draw under the notch; the web page has never asked for it. */
  viewportFitCover: boolean;
  /** href of the tab icon; null = the shell links none (Capacitor has the app's native icon). */
  icon: string | null;
  /** href of the web app manifest; null = none (only the installable web page has one). */
  manifest: string | null;
  /** Emit `<meta name="theme-color">` (the caller supplies the light colour; the boot script then keeps it current). */
  themeColor: boolean;
  /** `apple-mobile-web-app-title`: the name under an iOS home-screen icon, only meaningful for the installable page. */
  appleTitle: string | null;
}

/** The keyboard rule is in the viewport of every shell, not an option: lib/editorKeyboard relies on it (decisions-ui). */
export const SHARED_VIEWPORT = ["width=device-width", "initial-scale=1.0"] as const;
export const KEYBOARD_RULE = "interactive-widget=resizes-content";

export const APP_SHELLS: Record<AppShell, ShellOptions> = {
  web: {
    title: "Onden",
    description: "Onden knowledge website studio",
    viewportFitCover: false,
    icon: "/favicon.svg",
    manifest: "/manifest.webmanifest",
    themeColor: true,
    appleTitle: "Onden",
  },
  capacitor: {
    title: "Onden",
    description: "Onden knowledge website studio",
    viewportFitCover: true,
    icon: null,
    manifest: null,
    themeColor: false,
    appleTitle: null,
  },
  browser: {
    title: "Onden 試用版",
    description: "Onden 試用版：打開就能寫，資料只存在這個瀏覽器。",
    viewportFitCover: true,
    // Relative: the browser app can be served from any folder (vite.browser.config.ts `base: "./"`).
    icon: "./favicon.svg",
    manifest: null,
    themeColor: false,
    appleTitle: null,
  },
};

/** The viewport content of `shell`; the one place the keyboard rule is written. */
export function viewportContent(shell: AppShell): string {
  return [...SHARED_VIEWPORT, ...(APP_SHELLS[shell].viewportFitCover ? ["viewport-fit=cover"] : []), KEYBOARD_RULE].join(", ");
}

/** Head entries in render order. `themeColorLight` is required for (and only used by) shells with `themeColor`. */
export function appHeadEntries(shell: AppShell, themeColorLight?: string): HeadEntry[] {
  const o = APP_SHELLS[shell];
  const entries: HeadEntry[] = [
    { tag: "meta", attrs: { charset: "UTF-8" } },
    { tag: "meta", attrs: { name: "viewport", content: viewportContent(shell) } },
    { tag: "meta", attrs: { name: "description", content: o.description } },
    { tag: "title", text: o.title },
  ];
  if (o.icon) entries.push({ tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: o.icon } });
  if (o.manifest) entries.push({ tag: "link", attrs: { rel: "manifest", href: o.manifest } });
  if (o.themeColor) {
    if (!themeColorLight) throw new Error(`appHeadEntries("${shell}") needs themeColorLight`);
    entries.push({ tag: "meta", attrs: { name: "theme-color", content: themeColorLight } });
  }
  entries.push(
    { tag: "meta", attrs: { name: "mobile-web-app-capable", content: "yes" } },
    { tag: "meta", attrs: { name: "apple-mobile-web-app-capable", content: "yes" } },
    { tag: "meta", attrs: { name: "apple-mobile-web-app-status-bar-style", content: "default" } },
  );
  if (o.appleTitle) entries.push({ tag: "meta", attrs: { name: "apple-mobile-web-app-title", content: o.appleTitle } });
  return entries;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The head as HTML text, for the Vite shells (the Astro page renders the entries itself). */
export function renderAppHead(shell: AppShell, themeColorLight?: string): string {
  return appHeadEntries(shell, themeColorLight)
    .map((e) => {
      if (e.tag === "title") return `<title>${escapeHtml(e.text)}</title>`;
      const attrs = Object.entries(e.attrs).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(" ");
      return `<${e.tag} ${attrs} />`;
    })
    .join("\n    ");
}

/** Where a Vite shell (index.html, browser.html) asks for the head. */
export const APP_HEAD_PLACEHOLDER = "<!-- app-head -->";
