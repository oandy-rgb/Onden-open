// Finding a time zone (lib/timeZoneSearch): what people type — a city, a bigger
// city in the zone, a country, a generic name, an offset — and in what order the
// zones come back. The tables it reads (timeZoneCountries, timeZoneAliases) are
// guarded against the browser's own zone list.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../lib/i18n";
import { canonicalZone } from "../lib/timeLabels";
import { ZONE_ALIASES } from "../lib/timeZoneAliases";
import { COUNTRY_ZONES } from "../lib/timeZoneCountries";
import { browseZones, buildZoneIndex, foldZoneText, loadZoneDirectory, searchZones, type ZoneDirectory, type ZoneEntry } from "../lib/timeZoneSearch";
import { allTimeZones, commonZones } from "../lib/workspaceTime";

const NOW = new Date("2026-10-27T00:00:00Z"); // northern autumn: Denver −6, New York −4
let directory: ZoneDirectory;
let index: ZoneEntry[];
beforeAll(async () => {
  directory = await loadZoneDirectory();
  index = buildZoneIndex(allTimeZones(), directory, NOW);
});
beforeEach(() => setLocalePref("en"));

const zonesOf = (query: string) => searchZones(index, query).map((entry) => canonicalZone(entry.zone));
const has = (query: string, zone: string) => expect(zonesOf(query)).toContain(canonicalZone(zone));

describe("what a query finds", () => {
  it("a city that shares a bigger city's zone, in either language", () => {
    has("北京", "Asia/Shanghai");
    has("Beijing", "Asia/Shanghai");
    has("beijing", "Asia/Shanghai");
    has("深圳", "Asia/Shanghai");
    has("高雄", "Asia/Taipei");
    has("大阪", "Asia/Tokyo");
    has("釜山", "Asia/Seoul");
    has("舊金山", "America/Los_Angeles");
    has("Seattle", "America/Los_Angeles");
    has("波士頓", "America/New_York");
    has("新德里", "Asia/Kolkata");
    has("Mumbai", "Asia/Kolkata");
  });

  it("a country, in Chinese or English", () => {
    has("中國", "Asia/Shanghai");
    has("日本", "Asia/Tokyo");
    has("Japan", "Asia/Tokyo");
    has("台灣", "Asia/Taipei");
    has("臺灣", "Asia/Taipei");
    const america = zonesOf("美國");
    for (const zone of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"]) {
      expect(america).toContain(canonicalZone(zone));
    }
    expect(america).toEqual(expect.arrayContaining(zonesOf("United States")));
  });

  it("the city, the plain name and the IANA name", () => {
    expect(zonesOf("台北")[0]).toBe("Asia/Taipei");
    expect(zonesOf("tokyo")[0]).toBe("Asia/Tokyo");
    has("New York", "America/New_York");
    has("new_york", "America/New_York");
    has("ＴＯＫＹＯ", "Asia/Tokyo");
    has("america/denver", "America/Denver");
  });

  it("the browser's generic name, also for a zone that has a Chinese name", () => {
    has("中國標準時間", "Asia/Shanghai");
    has("China Standard Time", "Asia/Shanghai");
    has("Mountain Time", "America/Denver");
    has("山區", "America/Denver");
  });

  it("an offset, written the usual ways", () => {
    for (const query of ["+8", "UTC+8", "utc+8", "GMT+8", "＋８", "UTC+08:00", "+0800"]) {
      const found = searchZones(index, query);
      expect(found.length, query).toBeGreaterThan(3);
      expect(found.every((entry) => (query.includes("0") ? entry.offset === 480 : Math.trunc(entry.offset / 60) === 8)), query).toBe(true);
      expect(found.map((entry) => entry.zone), query).toContain("Asia/Taipei");
    }
    expect(zonesOf("UTC+5:30")).toContain("Asia/Calcutta");
    expect(searchZones(index, "UTC+5:30").every((entry) => entry.offset === 330)).toBe(true);
    // Whole hours: "+5" also finds the zones half an hour or 45 minutes later.
    expect(new Set(searchZones(index, "+5").map((entry) => entry.offset))).toEqual(new Set([300, 330, 345]));
    expect(searchZones(index, "-6").every((entry) => entry.offset === -360)).toBe(true);
    expect(zonesOf("-6")).toContain("America/Denver");
  });

  it("nothing for what no zone is called", () => {
    expect(searchZones(index, "zzz-nothing")).toEqual([]);
  });

  it("works before the tables have loaded, by names alone", () => {
    const bare = buildZoneIndex(allTimeZones(), null, NOW);
    expect(searchZones(bare, "tokyo").map((e) => e.zone)).toContain("Asia/Tokyo");
    expect(searchZones(bare, "北京")).toEqual([]);
    expect(bare.every((entry) => entry.detail === "")).toBe(true);
  });

  it("is quick enough to run on every keystroke", () => {
    const start = performance.now();
    for (const query of ["北京", "美", "a", "+8", "標準"]) searchZones(index, query);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("the order", () => {
  it("a name the query begins comes before a city or country that contains it, and before the rest", () => {
    const found = searchZones(index, "an");
    const tier = (entry: ZoneEntry) => (entry.names.some((n) => n.startsWith("an")) ? 0 : entry.related.some((n) => n.includes("an")) ? 1 : 2);
    expect(found.map(tier)).toEqual([...found.map(tier)].sort());
    expect(new Set(found.map(tier))).toEqual(new Set([0, 1, 2]));
  });

  it("a country's own zones come before a zone that only mentions the word", () => {
    expect(searchZones(index, "日本")[0]!.zone).toBe("Asia/Tokyo");
  });

  it("within a tier the common zones lead, then the full list's order", () => {
    const america = searchZones(index, "美國");
    const common = new Set(commonZones());
    const firstOther = america.findIndex((entry) => !common.has(canonicalZone(entry.zone)));
    expect(america.slice(0, firstOther).every((entry) => common.has(canonicalZone(entry.zone)))).toBe(true);
    const rest = america.slice(firstOther);
    expect(rest.map((e) => e.offset)).toEqual([...rest.map((e) => e.offset)].sort((a, b) => a - b));
  });
});

describe("before anything is typed", () => {
  it("lists this device's zone, the one in use, the common ones, then all the others by offset", () => {
    const { suggested, rest } = browseZones(index, { device: "Asia/Taipei", chosen: "Europe/Paris" });
    expect(suggested.slice(0, 2).map((e) => e.zone)).toEqual(["Asia/Taipei", "Europe/Paris"]);
    expect(suggested.length).toBeGreaterThan(40);
    expect(suggested.length + rest.length).toBe(index.length);
    expect(new Set([...suggested, ...rest]).size).toBe(index.length);
    expect(rest.map((e) => e.offset)).toEqual([...rest.map((e) => e.offset)].sort((a, b) => a - b));
    expect(rest.length).toBeGreaterThan(300); // not capped at 60
  });

  it("lists a zone once when device, choice and the common list overlap, and meets IANA's other spellings", () => {
    const { suggested } = browseZones(index, { device: "Asia/Taipei", chosen: "Asia/Kolkata" });
    expect(suggested.filter((e) => e.zone === "Asia/Taipei")).toHaveLength(1);
    expect(suggested[1]!.zone).toBe(canonicalZone("Asia/Kolkata"));
  });
});

describe("the labels", () => {
  it("add the country (and a generic name when the row's name lacks it) after the tables load", () => {
    const row = (zone: string) => index.find((entry) => entry.zone === canonicalZone(zone))!;
    expect(row("America/Denver").detail).toContain("United States");
    expect(row("Africa/Abidjan").detail).toContain("Côte d’Ivoire");
  });

  it("in Chinese", () => {
    setLocalePref("zh-TW");
    const zh = buildZoneIndex(allTimeZones(), directory, NOW);
    const denver = zh.find((entry) => entry.zone === "America/Denver")!;
    expect(denver.label).toBe("丹佛（UTC-6）");
    expect(denver.detail).toContain("美國");
  });
});

describe("folding", () => {
  it("ignores case, width, spaces, underscores and 臺/台", () => {
    expect(foldZoneText("New_York")).toBe(foldZoneText("ＮＥＷ york"));
    expect(foldZoneText("臺北")).toBe("台北");
    expect(foldZoneText("Xi'an")).toBe("xian");
  });
});

describe("the tables against the browser's list", () => {
  const listed = new Set(allTimeZones().map(canonicalZone));
  const zonesInCountries = Object.values(COUNTRY_ZONES).flatMap((list) => list.split(" "));

  it("every zone in the country table is one the browser lists", () => {
    const missing = zonesInCountries.filter((zone) => !listed.has(canonicalZone(zone)));
    expect(missing).toEqual([]);
  });

  it("every zone the browser lists has a country", () => {
    const covered = new Set(zonesInCountries.map(canonicalZone));
    expect([...listed].filter((zone) => zone !== "UTC" && !covered.has(zone))).toEqual([]);
  });

  it("every country code is a region the browser can name, and no zone is in two countries", () => {
    const names = new Intl.DisplayNames("en", { type: "region" });
    for (const code of Object.keys(COUNTRY_ZONES)) expect(names.of(code), code).not.toBe(code);
    expect(new Set(zonesInCountries).size).toBe(zonesInCountries.length);
  });

  it("every alias names a zone the browser lists", () => {
    const missing = Object.keys(ZONE_ALIASES).filter((zone) => !listed.has(canonicalZone(zone)));
    expect(missing).toEqual([]);
  });
});
