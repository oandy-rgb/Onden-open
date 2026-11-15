import type { Plugin } from "vite";
import { APP_HEAD_PLACEHOLDER, renderAppHead, type AppShell } from "./head";

/** Fills `<!-- app-head -->` in a Vite shell's HTML (build and dev) with the shared head of `shell` (./head.ts). */
export function appHeadPlugin(shell: Extract<AppShell, "capacitor" | "browser">): Plugin {
  return {
    name: "onden-app-head",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(APP_HEAD_PLACEHOLDER)) throw new Error(`${shell} shell: no ${APP_HEAD_PLACEHOLDER} in the page`);
        return html.replace(APP_HEAD_PLACEHOLDER, renderAppHead(shell));
      },
    },
  };
}
