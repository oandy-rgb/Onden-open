// 後端執行時 import 的 @onden/* 套件，三個地方都要知道：伺服器映像（docker/Dockerfile）、桌面版的 stage
// （packages/desktop/scripts/stage.mjs）、後端自己的 package.json。桌面版曾經漏掉 @onden/contract，要手動打包才發現。
// 清單只有一份：docker/runtime-packages.json；這裡檢查另外兩邊都照它做。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BACKEND = join(import.meta.dirname, "..", "..", "..");
const REPO = join(BACKEND, "..", "..");
const listed: string[] = JSON.parse(readFileSync(join(BACKEND, "docker/runtime-packages.json"), "utf8")).packages;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("後端執行時用到的 @onden/* 套件", () => {
  it("清單涵蓋後端正式程式碼（不含測試）import 的每一個 @onden 套件", () => {
    const imported = new Set<string>();
    for (const file of sourceFiles(join(BACKEND, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+["']@onden\/([a-z-]+)/g)) imported.add(m[1]!);
    }
    expect([...imported].sort()).toEqual([...listed].sort());
  });

  it("後端的 package.json dependencies 與清單一致", () => {
    const deps = Object.keys(JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8")).dependencies ?? {})
      .filter((name) => name.startsWith("@onden/")).map((name) => name.slice(7));
    expect(deps.sort()).toEqual([...listed].sort());
  });

  it("伺服器映像（Dockerfile）建置並帶走清單上的每個套件", () => {
    const dockerfile = readFileSync(join(BACKEND, "docker/Dockerfile"), "utf8");
    for (const pkg of listed) {
      expect(dockerfile, `Dockerfile 沒有建置 ${pkg}`).toContain(`npm run build --workspace=packages/${pkg}`);
      expect(dockerfile, `Dockerfile 沒有把 ${pkg} 的 dist 帶進執行階段`).toContain(`COPY --from=build /app/packages/${pkg}/dist ./packages/${pkg}/dist`);
    }
  });

  it("桌面版的 stage.mjs 讀同一份清單，而不是自己寫一份", () => {
    const stage = readFileSync(join(REPO, "packages/desktop/scripts/stage.mjs"), "utf8");
    expect(stage).toContain("packages/backend/docker/runtime-packages.json");
    // 不能再有寫死的套件陣列（["markdown", "contract", …]）：清單只有一份。
    expect(stage).not.toMatch(/\[\s*"(markdown|contract|site)"\s*,/);
  });
});
