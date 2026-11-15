import { MODULES, inModuleLibrary, type FrontendModule, type LibraryGroupPlacement, type ModuleStatusOf } from "../modules";

// How Settings › Features is laid out: the groups (what a feature is for), their
// order, and which features hang under another. The modules declare their own
// group, place and hosts (`library.group`, `requires`, `requiresAny`); this file
// only names the groups and arranges what the registry says, so a new feature
// appears in the right place without the page knowing it.

type GroupId = LibraryGroupPlacement["id"];

/** The groups in list order, with the heading each shows (i18n keys). */
export const LIBRARY_GROUPS: ReadonlyArray<{ id: GroupId; title: string }> = [
  { id: "search", title: "Search" },
  { id: "time", title: "Time" },
  { id: "reading", title: "Reading and learning" },
  { id: "ai", title: "AI" },
  { id: "publish", title: "Present and publish" },
];

/** One feature's row. `sub`: it hangs under a feature of its own group (skills under AI). */
export type LibraryRow = { mod: FrontendModule; sub: boolean };

const hostsOf = (mod: FrontendModule): readonly string[] => [...(mod.library.requires ?? []), ...(mod.library.requiresAny ?? [])];

/** The listed features, grouped and ordered as the settings list shows them. A
 *  group with none left is dropped. Only the features the list shows are taken. */
export function libraryLayout(mods: readonly FrontendModule[] = MODULES.filter(inModuleLibrary)): Array<{ id: GroupId; title: string; rows: LibraryRow[] }> {
  // A listed feature with no group would silently vanish from the page: fail loudly while developing.
  if (import.meta.env.DEV) {
    const lost = mods.filter((mod) => !LIBRARY_GROUPS.some((g) => g.id === mod.library.group?.id)).map((mod) => mod.id);
    if (lost.length > 0) throw new Error(`Settings › Features: no library.group for ${lost.join(", ")}`);
  }
  return LIBRARY_GROUPS.map(({ id, title }) => {
    const members = mods
      .filter((mod) => mod.library.group?.id === id)
      .sort((a, b) => a.library.group!.order - b.library.group!.order);
    const ids = new Set(members.map((mod) => mod.id));
    return { id, title, rows: members.map((mod) => ({ mod, sub: hostsOf(mod).some((host) => ids.has(host)) })) };
  }).filter((group) => group.rows.length > 0);
}

/** What the list shows for a feature: one that waits for its host is shown off, whatever it was
 *  set to (its own setting is kept and is back when the host is on again). */
export function shownStatus(mod: FrontendModule, status: ModuleStatusOf): ReturnType<ModuleStatusOf> {
  return waitingFor(mod, status) ? "off" : status(mod.id);
}

/** What a feature is waiting for: the features it needs that are not on, or
 *  null when it can be switched. `any`: one of `names` would do. */
export function waitingFor(mod: FrontendModule, status: ModuleStatusOf): { names: string[]; any: boolean } | null {
  const titleOf = (id: string) => MODULES.find((m) => m.id === id)?.library.title ?? id;
  const missing = (mod.library.requires ?? []).filter((id) => status(id) !== "on");
  if (missing.length > 0) return { names: missing.map(titleOf), any: false };
  const either = mod.library.requiresAny ?? [];
  if (either.length > 0 && either.every((id) => status(id) !== "on")) return { names: either.map(titleOf), any: true };
  return null;
}

/** The sentence for a feature that is waiting: 「要先打開日記或任務」. */
export function waitingText(waiting: { names: string[]; any: boolean }, t: typeof import("./i18n").t): string {
  const names = waiting.names.map((name) => t(name));
  const joined = names.reduce((list, name) => t(waiting.any ? "{a} or {b}" : "{a} and {b}", { a: list, b: name }));
  // A Latin name right after wording that is not Latin ("要先打開" + "AI") gets a space between.
  const lead = t("Turn on {name} first", { name: "|" }).split("|")[0];
  const spaced = /^[A-Za-z]/.test(joined) && lead.length > 0 && lead.charCodeAt(lead.length - 1) > 0x2e80 ? ` ${joined}` : joined;
  return t("Turn on {name} first", { name: spaced });
}
