// The app's registration of the translation tables (see lib/i18n.ts). Imported
// by bootApp so they are in place before the first render: a Chinese-locale
// user never sees English-first text at boot. The published site must not
// import this file (it would put the 180 KB table back).
import { dictionariesReady, getLocale, registerDictionary, setLateDictionary, subscribeLocale } from "./i18n";
import { ZH_TW_BOOT } from "./i18n.zh-TW.boot";

// Only the wording the boot screens use is in the boot JS (about half; the
// scripts/bootReportPlugin.mjs check keeps it that way). The rest is its own file,
// fetched after boot and before any lazyWithReload screen shows (lib/lazyWithReload).
registerDictionary("zh-TW", ZH_TW_BOOT);
setLateDictionary("zh-TW", () => import("./i18n.zh-TW.late").then((mod) => mod.ZH_TW_LATE));

// <html lang> follows the interface language, so screen readers and the
// browser's CJK glyph choice match what is shown. Only the app does this: a
// published site sets its own lang from the site's language setting.
const HTML_LANG = { en: "en", "zh-TW": "zh-Hant" } as const;
function syncHtmlLang(): void {
  if (typeof document !== "undefined") document.documentElement.lang = HTML_LANG[getLocale()];
}
syncHtmlLang();
subscribeLocale(syncHtmlLang);

// Fetch the late wording once the first screen is up, and again when the language
// is switched to one that has some. Idle time, so it never competes with boot.
function loadLateWording(): void { void dictionariesReady(); }
if (typeof window !== "undefined") {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (idle) idle.call(window, loadLateWording); else setTimeout(loadLateWording, 1500);
  subscribeLocale(loadLateWording);
}
