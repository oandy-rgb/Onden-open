// Rebuilds src/lib/timeZoneCountries.ts from the IANA zone.tab, keeping only the
// zones this engine's Intl.supportedValuesOf("timeZone") lists (by its own spelling).
//   node scripts/gen-time-zone-countries.mjs /usr/share/zoneinfo/zone.tab > src/lib/timeZoneCountries.ts
import { readFileSync } from "node:fs";

const listed = new Set(Intl.supportedValuesOf("timeZone"));
const canonical = (zone) => new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
const byCountry = new Map();
for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [country, , zone] = line.split("\t");
  if (!listed.has(canonical(zone))) continue;
  byCountry.set(country, [...(byCountry.get(country) ?? []), zone]);
}
const rows = [...byCountry].sort(([a], [b]) => a.localeCompare(b)).map(([country, zones]) => `  ${country}: "${zones.join(" ")}",`);
process.stdout.write(`// Time zone → ISO 3166 country, from the IANA zone.tab (scripts/gen-time-zone-countries.mjs).
// Only zones the browser lists; names are IANA's, matched through the engine's own
// spelling (lib/timeZoneSearch canonicalZone). Loaded on demand, with the city
// aliases, by the time zone picker.

export const COUNTRY_ZONES: Record<string, string> = {
${rows.join("\n")}
};
`);
