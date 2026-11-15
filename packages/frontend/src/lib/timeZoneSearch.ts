// Finding a time zone by what people call it: its plain name, its city, a bigger
// city in it (北京 → Asia/Shanghai), its country, the browser's generic name
// (中原標準時間), what is left of the IANA name, or its offset (UTC+8, +5:30).
// The picker (components/TimeZonePicker) builds an index once per opening and
// searches it on every keystroke. The country and city-alias tables are large
// and only this picker uses them, so they load on demand (loadZoneDirectory).
//
//   const index = buildZoneIndex(allTimeZones(), await loadZoneDirectory());
//   searchZones(index, "北京")  // → [Asia/Shanghai]
//   browseZones(index, { device, chosen })  // empty query: suggested, then the rest

import { canonicalZone, zoneGenericName } from "./timeLabels";
import { getLocale } from "./i18n";
import { zoneOffsetMinutes } from "./localDate";
import { cityOf, commonZoneName, commonZones, zoneLabel, zoneName } from "./workspaceTime";

export type ZoneDirectory = {
  /** ISO country code → its IANA zones, space-separated (timeZoneCountries). */
  countryZones: Record<string, string>;
  /** IANA zone → comma-separated cities, in any language (timeZoneAliases). */
  aliases: Record<string, string>;
};

export async function loadZoneDirectory(): Promise<ZoneDirectory> {
  const [{ COUNTRY_ZONES }, { ZONE_ALIASES }] = await Promise.all([import("./timeZoneCountries"), import("./timeZoneAliases")]);
  return { countryZones: COUNTRY_ZONES, aliases: ZONE_ALIASES };
}

export type ZoneEntry = {
  zone: string;
  /** Minutes east of UTC at the time the index was built. */
  offset: number;
  /** 「台北（UTC+8）」 */
  label: string;
  /** What tells same-named rows apart: country and the browser's generic name; "" while the tables load. */
  detail: string;
  common: boolean;
  /** Folded names a query may be the beginning of. */
  names: string[];
  /** Folded cities and countries around the zone. */
  related: string[];
  /** Folded names a query may be found inside of. */
  other: string[];
};

/** Case, width, spaces and punctuation out of the way: "New York" = "new_york" = "ＮＥＷ york"; 臺 = 台. */
export function foldZoneText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/臺/g, "台").replace(/[\s_\-'’.·]+/g, "");
}

const LOCALES = ["zh-TW", "en"] as const;

function countryNames(code: string): string[] {
  return LOCALES.flatMap((locale) => {
    try { return [new Intl.DisplayNames(locale, { type: "region" }).of(code) ?? ""]; } catch { return []; }
  }).filter(Boolean);
}

/** The generic name a row's detail line may add: skipped when the row's own name or its country already says it. */
function genericDetail(zone: string, label: string, country: string): string {
  const generic = zoneGenericName(zone, getLocale());
  if (!generic) return "";
  const stem = generic.replace(/標準時間$|時間$| Standard Time$| Time$/, "");
  return stem && !label.includes(stem) && !country.includes(stem) && !generic.includes(country) ? generic : "";
}

/** Every zone, in the order the full list shows them (offset, then name), ready to search.
 *  Without a directory the cities, countries and detail lines are simply missing. */
export function buildZoneIndex(zones: readonly string[], directory: ZoneDirectory | null = null, now: Date = new Date()): ZoneEntry[] {
  const countryOf = new Map<string, string[]>();
  const aliasesOf = new Map<string, string[]>();
  if (directory) {
    for (const [code, list] of Object.entries(directory.countryZones)) {
      const names = countryNames(code);
      for (const zone of list.split(" ")) countryOf.set(canonicalZone(zone), names);
    }
    for (const [zone, list] of Object.entries(directory.aliases)) aliasesOf.set(canonicalZone(zone), list.split(","));
  }
  const common = new Set(commonZones());
  const countryLabel = new Intl.DisplayNames(getLocale(), { type: "region" });
  const codeOf = new Map<string, string>();
  if (directory) for (const [code, list] of Object.entries(directory.countryZones)) for (const zone of list.split(" ")) codeOf.set(canonicalZone(zone), code);

  const entries = zones.map((zone): ZoneEntry => {
    const key = canonicalZone(zone);
    const label = zoneLabel(zone, now);
    const code = codeOf.get(key);
    const country = code ? countryLabel.of(code) ?? "" : "";
    const detail = directory ? [country, genericDetail(zone, label, country)].filter(Boolean).join(" · ") : "";
    return {
      zone, label, detail,
      offset: zoneOffsetMinutes(zone, now),
      common: common.has(key),
      names: [zoneName(zone), commonZoneName(zone) ?? "", cityOf(zone), zone].filter(Boolean).map(foldZoneText),
      related: [...(aliasesOf.get(key) ?? []), ...(countryOf.get(key) ?? [])].map(foldZoneText),
      other: [...LOCALES.map((locale) => zoneGenericName(zone, locale) ?? ""), zone].filter(Boolean).map(foldZoneText),
    };
  });
  return entries.sort((a, b) => a.offset - b.offset || (a.zone < b.zone ? -1 : 1));
}

// "UTC+8", "+8", "GMT-3", "+5:30", "+0530", "＋８".
const OFFSET_QUERY = /^(?:utc|gmt)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/i;

/** The offset a query asks for: minutes, or just whole hours ("+5" finds +5, +5:30 and +5:45). */
function offsetQuery(query: string): { sign: 1 | -1; hours: number; minutes: number | null } | null {
  const match = OFFSET_QUERY.exec(query.normalize("NFKC").trim());
  if (!match) return null;
  return { sign: match[1] === "+" ? 1 : -1, hours: Number(match[2]), minutes: match[3] === undefined ? null : Number(match[3]) };
}

function offsetMatches(entry: ZoneEntry, want: NonNullable<ReturnType<typeof offsetQuery>>): boolean {
  if (want.minutes === null) return Math.trunc(entry.offset / 60) === want.sign * want.hours;
  return entry.offset === want.sign * (want.hours * 60 + want.minutes);
}

/** 0: the query begins a name; 1: a city or country around it, or its offset; 2: it appears elsewhere; null: no match. */
function tierOf(entry: ZoneEntry, folded: string, offset: ReturnType<typeof offsetQuery>): 0 | 1 | 2 | null {
  if (offset) return offsetMatches(entry, offset) ? 1 : null;
  if (entry.names.some((name) => name.startsWith(folded))) return 0;
  if (entry.related.some((name) => name.includes(folded))) return 1;
  if (entry.names.some((name) => name.includes(folded)) || entry.other.some((name) => name.includes(folded))) return 2;
  return null;
}

/** The zones a query finds, best first: names it begins, then cities and countries
 *  (and offsets), then the rest. Within a tier the common zones come first, then the
 *  full list's order. An empty query finds all. */
export function searchZones(index: readonly ZoneEntry[], query: string): ZoneEntry[] {
  const folded = foldZoneText(query);
  if (!folded) return [...index];
  const offset = offsetQuery(query);
  const found: Array<{ entry: ZoneEntry; tier: number; at: number }> = [];
  index.forEach((entry, at) => {
    const tier = tierOf(entry, folded, offset);
    if (tier !== null) found.push({ entry, tier, at });
  });
  return found.sort((a, b) => a.tier - b.tier || Number(b.entry.common) - Number(a.entry.common) || a.at - b.at).map((hit) => hit.entry);
}

/** What the picker shows before anything is typed: this device's zone, the one in use,
 *  the common ones, then every other zone by offset. */
export function browseZones(index: readonly ZoneEntry[], pick: { device?: string; chosen?: string }): { suggested: ZoneEntry[]; rest: ZoneEntry[] } {
  const byZone = new Map(index.map((entry) => [canonicalZone(entry.zone), entry]));
  const first = [pick.device, pick.chosen].flatMap((zone) => {
    const entry = zone ? byZone.get(canonicalZone(zone)) : undefined;
    return entry ? [entry] : [];
  });
  const suggested = [...new Set([...first, ...commonZones().flatMap((zone) => byZone.get(zone) ?? [])])];
  const taken = new Set(suggested);
  return { suggested, rest: index.filter((entry) => !taken.has(entry)) };
}
