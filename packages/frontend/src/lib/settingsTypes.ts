import type { TabId, SettingsTab } from "./settingsTab";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// Joplin-style registry: every setting is a data object. Renderer derives UI
// from `type`. Custom flows (folder picker, multi-state import) use `custom`
// type with an inline component. New settings = 1 array entry; for free you
// get search / advanced folding / restart flag / show-if conditional /
// plugin extensibility (eventual `registerSettings(...)`).
//
// Reference: joplin-dev/packages/lib/models/settings/builtInMetadata.ts
//            Trilium-main/apps/client/src/widgets/react/hooks.tsx (useTriliumOption)

/** The settings list's blocks, in order. They carry no name on screen: a thin
 *  gap separates them, as iPhone Settings does. */
export type ListSectionId = "profile" | "look" | "workspace" | "locale" | "data";

export type TabSpec = {
  id: TabId;
  label: string;
  icon: ReactNode;
  /** Where the settings list shows the tab (LIST_SECTIONS), on both layouts. */
  listSection: ListSectionId;
  /** Kept only in this browser, so the row carries a small phone mark. */
  deviceOnly?: boolean;
  /** Only where there is a keyboard (not listed on the phone). */
  desktopOnly?: boolean;
  /** Only the workspace owner sees this page in the list (the server refuses everyone else as well). */
  ownerOnly?: boolean;
};

// Context passed to every setting + custom widget. Settings that depend on
// runtime state (e.g. `online`) or need callbacks (e.g. onClose) read here.
export type SettingContext = {
  online: boolean;
  onClose: () => void;
  onImportDone: () => void;
  onConnect: () => void;
  /** Switch the settings screen to another tab (a widget's "Go to …"). */
  openTab?: (tab: SettingsTab, opts?: { advanced?: boolean }) => void;
  /** Close settings and open a tag's page. */
  openTag?: (id: string) => void;
  /** Close settings and open a note. */
  openNote?: (id: string) => void;
};

interface BaseSettingDef {
  id: string;
  tab: TabId;
  /** Optional visible sub-heading within a tab (e.g. "Export" / "Import" /
   *  "Storage & backup" inside Your Data). Settings sharing a section render
   *  under one header in registry order; settings without one group silently
   *  by id-prefix (legacy behaviour). */
  section?: string;
  label: string;
  description?: string;
  hint?: string;
  /** Conditional visibility. Receives the full context + current values. */
  show?: (ctx: SettingContext) => boolean;
  needsRestart?: boolean;
  /** Hidden until "Show advanced settings" (search still finds it). A
   *  function decides from the context, e.g. the backend URL is advanced only
   *  while connected. */
  advanced?: boolean | ((ctx: SettingContext) => boolean);
  /** Extra words settings search matches, for a widget whose label says
   *  little about what is inside it (both languages). */
  keywords?: readonly string[];
  /** Set for a module's own setting (modules/index MODULE_SETTINGS), which
   *  shows on that module's card in the module library. */
  moduleId?: string;
  /** Only where there is a keyboard: not listed on the phone. */
  desktopOnly?: boolean;
  /** Only the workspace owner sees it (list, page and search). */
  ownerOnly?: boolean;
  /** Deletes or replaces something: drawn last on its page, in red. */
  danger?: boolean;
}

/** How a number or enum setting is drawn instead of the plain field: a
 *  slider whose two ends are icons (small / large), or one colour swatch per
 *  option (`swatch` names a preview look the stylesheet knows). */
export type SettingControl =
  | { slider: readonly [LucideIcon, LucideIcon] }
  | { swatches: true }
  | { segmented: true }
  /** One card per option, each drawn with the icon named for its value. */
  | { cards: Readonly<Record<string, LucideIcon>> };

/** How a value setting persists and takes effect (settings/useOption.ts).
 *  By default the value is stored (lib/prefs, device scope) under `storageKey` (or the
 *  id) through the type's codec. `apply` is the side effect alone (a CSS
 *  variable, a DOM attribute): it runs on every change and once at boot,
 *  and never persists. `get`/`set` replace the storage for a setting kept
 *  elsewhere (the locale, the server URL, an account preference); `set` then
 *  also persists. */
interface ValueSettingFields<T> {
  storageKey?: string;
  apply?: (v: T) => void;
  get?: () => T;
  set?: (v: T) => void;
  /** For a `get` whose value changes underneath (an account setting a sync
   *  brings in): calls the listener on each change; returns how to stop. */
  subscribe?: (listener: () => void) => () => void;
}

export interface BoolSettingDef extends BaseSettingDef, ValueSettingFields<boolean> {
  type: "boolean";
  default: boolean;
}

export interface NumberSettingDef extends BaseSettingDef, ValueSettingFields<number> {
  type: "number";
  control?: Extract<SettingControl, { slider: unknown }>;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface TextSettingDef extends BaseSettingDef, ValueSettingFields<string> {
  type: "text";
  default: string;
  placeholder?: string;
  /** Renders as <input type="password">. */
  secret?: boolean;
  /** Optional "Save" button + custom action (e.g. trigger connection test).
   *  Without this, edits debounce-save on blur. */
  /** run may return a message to show under the field (the action failed). */
  action?: { label: string; run: (v: string, ctx: SettingContext) => void | string | Promise<void | string> };
}

export interface EnumSettingDef<T extends string = string> extends BaseSettingDef, ValueSettingFields<T> {
  type: "enum";
  control?: SettingControl;
  default: T;
  options: ReadonlyArray<{ value: T; label: string }>;
}

/** Single-click action(s) with no associated value. Multiple buttons = a row. */
export interface ActionSettingDef extends BaseSettingDef {
  type: "action";
  buttons: ReadonlyArray<{
    label: string;
    icon?: ReactNode;
    variant?: "primary" | "ghost";
    /** Disabled while running; runner can throw to bail. */
    run: (ctx: SettingContext) => void | Promise<void>;
  }>;
}

/** Escape hatch for multi-state flows (folder import progress, OPFS↔FS
 *  switcher). Component owns its own state; receives the setting context. */
export interface CustomSettingDef extends BaseSettingDef {
  type: "custom";
  component: React.ComponentType<{ ctx: SettingContext }>;
  /** For a widget whose choice is a page-level DOM change: replays it at boot
   *  from the widget's own storage (APPEARANCE_SETTINGS only). */
  apply?: () => void;
}

export type SettingDef =
  | BoolSettingDef
  | NumberSettingDef
  | TextSettingDef
  | EnumSettingDef
  | ActionSettingDef
  | CustomSettingDef;
