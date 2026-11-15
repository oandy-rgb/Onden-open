import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SRC } from "../sources";

/** Every .css file under src/ (sources.ts walks .ts/.tsx only). */
export function cssFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "test" ? [] : cssFiles(full);
    return name.endsWith(".css") ? [full] : [];
  });
}
