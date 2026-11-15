// App-UI i18n (layer B) — gettext-style: the ENGLISH string IS the key.
// Components keep readable English literals; t() looks the literal up in the
// active locale's dictionary and falls back to the literal itself, so an
// untranslated string renders in English instead of breaking. Adding a
// language = one dictionary file + one entry in DICTIONARIES.
//
// (Layer A — the published site's chrome — is separate and already shipped:
// components/templates/siteLocale.ts, driven by the site's Design settings.
// This module is about the app shell the OWNER sees.)
//
// Reactivity: a tiny external store. Components subscribe via useT(); locale
// changes re-render subscribers without a page reload. Non-component call
// sites (toasts, one-shot messages) may import t directly — they format at
// event time, so staleness isn't a concern.

import { useSyncExternalStore } from "react";
import { PREFS, getPref, setPref } from "./prefs";

export type AppLocale = "en" | "zh-TW";
/** What the user picks in Settings — "system" resolves via navigator. */
export type LocalePref = AppLocale | "system";


// Filled by registerDictionary. This module deliberately imports no
// dictionary: the zh-TW table is 180 KB and the published site also imports
// t(). The app registers it at boot (lib/i18n.app.ts, via bootApp); the site
// pages keep the English literals.
const DICTIONARIES: Partial<Record<Exclude<AppLocale, "en">, Record<string, string>>> = {};

const REGISTERED: Partial<Record<Exclude<AppLocale, "en">, Set<Record<string, string>>>> = {};

/** Add `dict`'s wording for `locale` and re-render subscribers when it is the
 *  active locale: the app's table at boot, and a part loaded later (the info
 *  panel's tabs, a module's screens) its own strings when it loads. Always
 *  additive: registering one part never removes another's wording. Before any
 *  registration t() returns the English literal. */
export function registerDictionary(locale: Exclude<AppLocale, "en">, dict: Record<string, string>): void {
  const registered = (REGISTERED[locale] ??= new Set());
  if (registered.has(dict)) return;
  registered.add(dict);
  DICTIONARIES[locale] = { ...DICTIONARIES[locale], ...dict };
  if (current === locale) for (const l of listeners) l();
}

type LateLoader = () => Promise<Record<string, string>>;
const LATE_LOADERS: Partial<Record<Exclude<AppLocale, "en">, LateLoader>> = {};
const lateLoading = new Map<string, Promise<void>>();

/** Name the part of `locale`'s wording that is not loaded at boot (the strings only
 *  screens loaded on use show). dictionariesReady() fetches it and registers it. */
export function setLateDictionary(locale: Exclude<AppLocale, "en">, load: LateLoader): void {
  LATE_LOADERS[locale] = load;
  lateLoading.delete(locale);
}

/** Resolves once the active locale's late wording is registered (at once for English
 *  or when there is none). Never rejects: if the file cannot be fetched (offline and
 *  not cached) the English literals show and the next call tries again. Call it before
 *  showing a screen loaded on use, so that screen does not flash English first. */
export function dictionariesReady(): Promise<void> {
  const locale = current;
  if (locale === "en") return Promise.resolve();
  const load = LATE_LOADERS[locale];
  if (!load) return Promise.resolve();
  let pending = lateLoading.get(locale);
  if (!pending) {
    pending = load().then((dict) => registerDictionary(locale, dict), () => { lateLoading.delete(locale); });
    lateLoading.set(locale, pending);
  }
  return pending;
}

/** The device's language tag (`navigator.language`), "en" where there is none. */
export function systemLanguageTag(): string {
  return (typeof navigator !== "undefined" && navigator.language) || "en";
}

function systemLocale(): AppLocale {
  return /^zh/i.test(systemLanguageTag()) ? "zh-TW" : "en";
}

export function getLocalePref(): LocalePref {
  const raw = getPref(PREFS.locale);
  return raw === "en" || raw === "zh-TW" || raw === "system" ? raw : "system";
}

export function resolveLocale(pref: LocalePref = getLocalePref()): AppLocale {
  return pref === "system" ? systemLocale() : pref;
}

let current: AppLocale = resolveLocale();
const listeners = new Set<() => void>();

export function setLocalePref(pref: LocalePref): void {
  setPref(PREFS.locale, pref);
  const next = resolveLocale(pref);
  if (next !== current) {
    current = next;
    for (const l of listeners) l();
  }
}

export function getLocale(): AppLocale {
  return current;
}

/** Translate one app-UI string. `vars` interpolates {name} placeholders —
 *  the placeholder survives into the dictionary value, so word order is the
 *  translator's call. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const dict = current === "en" ? undefined : DICTIONARIES[current];
  let out = dict?.[text] ?? text;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** A phrase with a count: `one` when the count is 1, `other` otherwise (English
 *  only has these two forms; zh-TW gives both keys the same wording). `{n}` and
 *  `{count}` are filled with `count`; `vars` adds the rest and may override them.
 *  The one place a plural is chosen — no `n === 1 ? t(…) : t(…)`, no "(s)". */
export function tn(one: string, other: string, count: number, vars?: Record<string, string | number>): string {
  return t(count === 1 ? one : other, { n: count, count, ...vars });
}

/** Whether the current locale has its own wording for `text` (English always does). */
export function hasTranslation(text: string): boolean {
  return current === "en" || DICTIONARIES[current]?.[text] !== undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Notify `listener` when the active locale changes (non-React callers; components use useT). */
export const subscribeLocale = subscribe;

/** Subscribe a component to locale changes; returns t. Use this (not a bare
 *  t import) inside components so a Settings language switch re-renders them. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, getLocale, () => "en");
  return t;
}
