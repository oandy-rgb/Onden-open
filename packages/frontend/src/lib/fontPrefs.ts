// 介面字型 and 內文字型 (Settings › Appearance › Fonts): the person's choice follows the
// account (pref `fonts`), but fonts are the device's: a custom family this device lacks
// shows the built-in face here, and the choice stays so a device that has it uses it.
//
//   choice (account, synced)  →  stacks (this device: PREFS.fontStacks)  →  CSS variables
//
// This file is the small, boot-resident part (BuilderWorkspace keeps the pref in sync); resolving
// a choice against this device (lib/fontApply) and the settings widget load on use.

import { cutToUnits } from "@onden/markdown";
import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";

export type FontMode = "default" | "system" | "custom";
export type FontPick = { mode: FontMode; name?: string };
export type FontChoices = { ui: FontPick; body: FontPick };
export type FontRole = keyof FontChoices;

export const DEFAULT_FONT_CHOICES: FontChoices = { ui: { mode: "default" }, body: { mode: "default" } };
export const FONT_NAME_MAX = 80;

/** A family name as typed: no quotes, braces, semicolons or control characters (it ends up in CSS). */
export function cleanFontName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  return cutToUnits(raw.replace(/[\u0000-\u001f"'\\;{}<>()]/g, "").replace(/\s+/g, " ").trim(), FONT_NAME_MAX);
}

function parsePick(value: unknown): FontPick | null {
  if (typeof value !== "object" || value === null) return null;
  const { mode, name } = value as { mode?: unknown; name?: unknown };
  if (mode === "default" || mode === "system") return { mode };
  if (mode !== "custom") return null;
  const clean = typeof name === "string" ? cleanFontName(name) : "";
  return { mode, name: clean };
}

export function parseFontChoices(value: unknown): FontChoices | null {
  if (typeof value !== "object" || value === null) return null;
  const ui = parsePick((value as { ui?: unknown }).ui);
  const body = parsePick((value as { body?: unknown }).body);
  return ui && body ? { ui, body } : null;
}

export const fontsPref = createAccountPref<FontChoices>({
  serverKey: "fonts",
  follows: "account", // typeface choice: a taste (size is the judgment call, see PR audit)
  copy: PREFS.fontsCopy,
  parse: parseFontChoices,
});
