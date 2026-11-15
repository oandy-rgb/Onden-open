import type { Snippet } from "@onden/markdown";

// A false result keeps the panel open; the action owner has already reported
// its refusal. A Promise settles before the panel clears the user query.
export type PaletteAction = () => void | boolean | Promise<void | boolean>;

export type PaletteItem =
  | { kind: "node"; id: string; title: string; hint: string; group?: string; snippet?: Snippet | null }
  | {
      kind: "action";
      id: string;
      label: string;
      hint: string;
      group?: string;
      run: PaletteAction;
      // Fuzzy-match synonyms so "trash"/"remove" find "Delete", etc. Searched
      // alongside `label` by Fuse; never shown.
      keywords?: string[];
      // SHORTCUTS id whose chord renders as a right-aligned kbd badge (and keeps
      // the palette in sync with the real dispatcher binding). Defaults to `id`
      // when omitted, so an action whose id matches a SHORTCUTS entry auto-shows.
      shortcutId?: string;
      // Context-availability: when this returns false the row renders disabled
      // (greyed, with a reason tooltip) rather than being hidden.
      when?: () => boolean;
      // Why the action is unavailable — shown as the disabled row's tooltip.
      disabledReason?: string;
    }
  | { kind: "canvas"; id: string; label: string; hint: string; group?: string; run: PaletteAction }
  // Create-on-miss row: `title` is the raw query to create; `label` is the
  // rendered "Create note: …" text.
  | { kind: "create"; id: string; title: string; label: string; hint: string; group?: string; run: PaletteAction };
