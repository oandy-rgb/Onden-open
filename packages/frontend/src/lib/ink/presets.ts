// Pen presets: a tool, a colour and a thickness saved under a name, so one tap
// brings the whole pen back. Pure — the account pref that keeps them is
// lib/inkPrefs.ts (backend services/actorPrefs `inkPresets` holds the same shape).

import { cutToGraphemes, INK_PRESET_NAME_MAX } from "@onden/markdown";
import { normalizeHex } from "./palette";

/** The tools a preset can hold: the two that draw with a colour and a thickness. */
export const PRESET_TOOLS = ["pen", "highlighter"] as const;
export type PresetTool = (typeof PRESET_TOOLS)[number];
/** The thickness ids of the toolbar (components/InkToolbar INK_SIZES). */
export const PRESET_SIZE_IDS = ["fine", "medium", "broad"] as const;

export const MAX_PRESETS = 6;

export interface InkPreset {
  id: string;
  /** The person's own words; empty = shown by its tool and thickness. */
  name: string;
  tool: PresetTool;
  /** `#rrggbb`. */
  color: string;
  sizeId: (typeof PRESET_SIZE_IDS)[number];
}

export type InkPresetList = InkPreset[];

const isTool = (v: unknown): v is PresetTool => (PRESET_TOOLS as readonly unknown[]).includes(v);
const isSizeId = (v: unknown): v is InkPreset["sizeId"] => (PRESET_SIZE_IDS as readonly unknown[]).includes(v);

/** The stored list, made safe: a bad entry (or a duplicate id) is dropped, at most MAX_PRESETS kept. */
export function parsePresets(value: unknown): InkPresetList | null {
  if (!Array.isArray(value)) return null;
  const out: InkPresetList = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const color = normalizeHex(e.color);
    if (typeof e.id !== "string" || e.id === "" || !color || !isTool(e.tool) || !isSizeId(e.sizeId)) continue;
    if (out.some((p) => p.id === e.id) || out.length >= MAX_PRESETS) continue;
    out.push({ id: e.id, name: typeof e.name === "string" ? cutToGraphemes(e.name, INK_PRESET_NAME_MAX) : "", tool: e.tool, color, sizeId: e.sizeId });
  }
  return out;
}

export function canAddPreset(list: InkPresetList): boolean { return list.length < MAX_PRESETS; }

/** `preset` joins the end of the list; refused (list unchanged) when it is full. */
export function withPreset(list: InkPresetList, preset: InkPreset): InkPresetList {
  return canAddPreset(list) ? [...list, preset] : list;
}

export function withoutPreset(list: InkPresetList, id: string): InkPresetList {
  return list.filter((p) => p.id !== id);
}

/** The new name, trimmed and cut to INK_PRESET_NAME_MAX characters (a name is the person's text, never split mid-character). */
export function withPresetName(list: InkPresetList, id: string, name: string): InkPresetList {
  const trimmed = cutToGraphemes(name.trim(), INK_PRESET_NAME_MAX);
  return list.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
}

/** Whether the pen is exactly this preset (the list highlights the one in use). */
export function presetMatches(preset: InkPreset, pen: { tool: string; color: string; sizeId: string }): boolean {
  return preset.tool === pen.tool && preset.color.toLowerCase() === pen.color.toLowerCase() && preset.sizeId === pen.sizeId;
}
