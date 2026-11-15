// The workspace's calendar clock as the person sees it: a time zone with a
// plain name and its offset, and the hour a day starts at (Settings › Time,
// the travel question). The clock itself lives on the server (backend
// localDay.ts); lib/localDate.ts reads it for "today". Nothing here writes.

import { getLocale } from "./i18n";
import { dateIdAt, zoneOffsetMinutes } from "./localDate";
import { canonicalZone, zoneGenericName } from "./timeLabels";

export { deviceTimeZone, zoneOffsetMinutes } from "./localDate";

/** The zone the workspace's days are cut in, from the loaded bootstrap: the
 *  owner's choice, else the server's (ONDEN_TIMEZONE), else undefined (the
 *  browser's own stands in until the server says). */
export function workspaceZoneOf(data: { workspace?: { time_zone?: string | null } | null; timezone?: string | null }): string | undefined {
  return data.workspace?.time_zone ?? data.timezone ?? undefined;
}

/** Every zone the server accepts: the IANA list and UTC (backend localDay.ts). */
export function allTimeZones(): string[] {
  let zones: string[] = [];
  try { zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { /* old engine */ }
  return [...new Set([...zones, "UTC"])].sort();
}

/** "UTC+8", "UTC+5:30", "UTC-3", "UTC". */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

// Plain names for the zones people mostly live in or travel to. Any other zone
// falls back to the browser's own name for it, then to its city.
const ZH_NAMES: Record<string, string> = {
  "UTC": "世界標準時間", "Asia/Taipei": "台北", "Asia/Tokyo": "東京", "Asia/Seoul": "首爾", "Asia/Shanghai": "上海",
  "Asia/Hong_Kong": "香港", "Asia/Macau": "澳門", "Asia/Singapore": "新加坡", "Asia/Bangkok": "曼谷",
  "Asia/Ho_Chi_Minh": "胡志明市", "Asia/Jakarta": "雅加達", "Asia/Manila": "馬尼拉", "Asia/Kuala_Lumpur": "吉隆坡",
  "Asia/Kolkata": "印度", "Asia/Dubai": "杜拜", "Asia/Karachi": "喀拉蚩", "Asia/Dhaka": "達卡", "Asia/Kathmandu": "加德滿都",
  "Asia/Jerusalem": "耶路撒冷", "Asia/Tehran": "德黑蘭", "Europe/Istanbul": "伊斯坦堡", "Europe/Moscow": "莫斯科",
  "Europe/London": "倫敦", "Europe/Paris": "巴黎", "Europe/Berlin": "柏林", "Europe/Madrid": "馬德里", "Europe/Rome": "羅馬",
  "Europe/Amsterdam": "阿姆斯特丹", "Europe/Zurich": "蘇黎世", "Europe/Lisbon": "里斯本", "Europe/Dublin": "都柏林",
  "Europe/Athens": "雅典", "Europe/Vienna": "維也納", "Europe/Stockholm": "斯德哥爾摩", "Europe/Prague": "布拉格",
  "Africa/Cairo": "開羅", "Africa/Johannesburg": "約翰尼斯堡", "Africa/Lagos": "拉哥斯", "Africa/Nairobi": "奈洛比",
  "America/New_York": "紐約", "America/Chicago": "芝加哥", "America/Denver": "丹佛", "America/Los_Angeles": "洛杉磯",
  "America/Vancouver": "溫哥華", "America/Toronto": "多倫多", "America/Mexico_City": "墨西哥城", "America/Sao_Paulo": "聖保羅",
  "America/Argentina/Buenos_Aires": "布宜諾斯艾利斯", "America/Bogota": "波哥大", "America/Lima": "利馬", "America/Santiago": "聖地牙哥",
  "America/Anchorage": "安克拉治", "Pacific/Honolulu": "檀香山", "Australia/Sydney": "雪梨", "Australia/Melbourne": "墨爾本",
  "Australia/Brisbane": "布里斯本", "Australia/Perth": "伯斯", "Pacific/Auckland": "奧克蘭", "Pacific/Guam": "關島",
};

let zhNames: Map<string, string> | undefined;
/** The plain Chinese name of one of the common zones, whichever way the browser spells it. */
export function commonZoneName(zone: string): string | undefined {
  zhNames ??= new Map(Object.entries(ZH_NAMES).map(([key, name]) => [canonicalZone(key), name]));
  return zhNames.get(canonicalZone(zone));
}

/** The zones people mostly live in or travel to, in the browser's spelling. */
export function commonZones(): string[] {
  return Object.keys(ZH_NAMES).map(canonicalZone);
}

export function cityOf(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** A zone in plain words: 台北, Tokyo — never the IANA name itself unless the
 *  zone has no other name the browser knows. */
export function zoneName(zone: string): string {
  if (zone === "UTC") return getLocale() === "zh-TW" ? ZH_NAMES.UTC! : "UTC";
  if (getLocale() === "zh-TW") {
    const known = commonZoneName(zone);
    if (known) return known;
    // Many zones share one generic name (格林威治標準, 東非…): the city tells them apart.
    const generic = zoneGenericName(zone, "zh-TW");
    if (generic) return `${cityOf(zone)} · ${generic.replace(/時間$/, "")}`;
  }
  return cityOf(zone);
}

/** 「台北（UTC+8）」 — the name and where the zone is now. */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  const name = zoneName(zone);
  const offset = formatOffset(zoneOffsetMinutes(zone, at));
  return name === offset ? name : `${name}（${offset}）`;
}

/** A "day starts at" hour as the clock shows it: 04:00. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Today's id on a clock — a zone (undefined: the browser's) and a start hour. */
export function dayOnClock(now: Date, timeZone: string | undefined, dayStartHour: number): string {
  return dateIdAt(now, timeZone, dayStartHour);
}

export type Clock = { timeZone: string | undefined; dayStartHour: number };

/** 10/27 — a day id as month/day, for a sentence. */
export function shortDay(dayId: string): string {
  const [, month, day] = dayId.split("-");
  return `${Number(month)}/${Number(day)}`;
}
