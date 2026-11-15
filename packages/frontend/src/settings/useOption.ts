import { useEffect, useState } from "react";
import { getPref, setPref, settingPref } from "../lib/prefs";
import type { SettingDef } from "../lib/settingsTypes";
import { onWindow } from "../lib/globalEvents";

// One persistence path for every value setting: read and write go through
// the type's codec under the def's storage key, `apply` runs the side effect
// on each change, and boot replays the same codec (applyPersistedSettings in
// registry.tsx). Storage is wrapped (lib/prefs, device scope), so blocked storage
// leaves defaults in place instead of throwing.
//
// Cross-tab sync: a stored setting follows `storage` events from other tabs.
// A def with its own get/set persists elsewhere and doesn't fire them.

export type ValueSettingDef = Extract<SettingDef, { type: "boolean" | "number" | "text" | "enum" }>;
export type SettingValue<D extends ValueSettingDef> = D["default"];

/** How a value is stored as text; decode returns undefined for a value it
 *  cannot read, and the setting falls back to its default. */
type Codec = { decode: (raw: string, def: ValueSettingDef) => unknown; encode: (v: unknown) => string };

const CODECS: Record<ValueSettingDef["type"], Codec> = {
  boolean: { decode: (raw) => (raw === "true" ? true : raw === "false" ? false : undefined), encode: String },
  number: {
    decode: (raw) => { const n = Number(raw); return raw.trim() !== "" && Number.isFinite(n) ? n : undefined; },
    encode: String,
  },
  text: { decode: (raw) => raw, encode: String },
  // An enum only accepts one of its options (an old or hand-edited value
  // would otherwise reach the setting's side effect).
  enum: { decode: (raw, def) => (def.type === "enum" && def.options.some((o) => o.value === raw) ? raw : undefined), encode: String },
};

function storageKeyOf(def: ValueSettingDef): string {
  return def.storageKey ?? def.id;
}

/** The setting's current value: its own get(), else storage through the codec. */
export function readValue<D extends ValueSettingDef>(def: D): SettingValue<D> {
  if (def.get) return def.get() as SettingValue<D>;
  const raw = getPref(settingPref(storageKeyOf(def)));
  if (raw === null) return def.default as SettingValue<D>;
  const decoded = CODECS[def.type].decode(raw, def);
  return (decoded === undefined ? def.default : decoded) as SettingValue<D>;
}

// Surfaces that only show a value (the settings list's right-hand column)
// hear of a write made on another surface (the page beside it) here.
const writeListeners = new Set<() => void>();

/** Persist a value (its own set(), else storage) and run its side effect. */
export function writeValue<D extends ValueSettingDef>(def: D, value: SettingValue<D>): void {
  const anyDef = def as { set?: (v: unknown) => void; apply?: (v: unknown) => void };
  if (anyDef.set) anyDef.set(value);
  else setPref(settingPref(storageKeyOf(def)), CODECS[def.type].encode(value));
  anyDef.apply?.(value);
  for (const listener of writeListeners) listener();
}

/** The setting's current value, read-only, following writes made anywhere in this page. */
export function useSettingValue<D extends ValueSettingDef>(def: D): SettingValue<D> {
  const [value, setValue] = useState<SettingValue<D>>(() => readValue(def));
  useEffect(() => {
    const refresh = () => setValue(readValue(def));
    writeListeners.add(refresh);
    refresh();
    return () => { writeListeners.delete(refresh); };
  }, [def]);
  return value;
}

export function useOption<D extends ValueSettingDef>(def: D): [SettingValue<D>, (v: SettingValue<D>) => void] {
  const [value, setLocal] = useState<SettingValue<D>>(() => readValue(def));
  useEffect(() => {
    if (def.subscribe) return def.subscribe(() => setLocal(readValue(def)));
    if (def.get) return;
    const key = storageKeyOf(def);
    const onStorage = (e: StorageEvent) => { if (e.key === key) setLocal(readValue(def)); };
    return onWindow("storage", onStorage);
  }, [def]);
  const setter = (v: SettingValue<D>) => {
    writeValue(def, v);
    setLocal(v);
  };
  return [value, setter];
}
