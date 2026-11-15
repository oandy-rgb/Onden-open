import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
/** `virtual:migrations`：把 packages/backend/db/migrations/*.sql 內嵌成 [版本, SQL][]。 */
export function migrationsPlugin(root) {
  return {
    name: "migrations",
    setup(b) {
      b.onResolve({ filter: /^virtual:pgroonga-compat$/ }, () => ({ path: "compat", namespace: "mig" }));
      b.onResolve({ filter: /^virtual:migrations$/ }, () => ({ path: "migrations", namespace: "mig" }));
      b.onLoad({ filter: /.*/, namespace: "mig" }, (args) => {
        if (args.path === "compat") return { contents: `export default ${JSON.stringify(readFileSync(resolve(root, "docs/research/browser-trial/src/pgroongaCompat.sql"), "utf8"))};`, loader: "js" };
        const dir = resolve(root, "packages/backend/db/migrations");
        const list = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => [f.replace(/\.sql$/, ""), readFileSync(resolve(dir, f), "utf8")]);
        return { contents: `export default ${JSON.stringify(list)};`, loader: "js" };
      });
    },
  };
}

/** 實驗用的一行修補：把 db.ts 的 AsyncLocalStorage 露給驅動（正式做法見 README「資料庫替換層」）。 */
export function exposeTxStorage(root) {
  const file = resolve(root, "packages/backend/src/db.ts");
  return {
    name: "expose-tx-storage",
    setup(b) {
      b.onLoad({ filter: /packages\/backend\/src\/db\.ts$/ }, (args) => {
        if (args.path !== file) return;
        const src = readFileSync(file, "utf8");
        const marker = "const txStorage = new AsyncLocalStorage<pg.PoolClient>();";
        if (!src.includes(marker)) throw new Error("db.ts 變了：找不到 txStorage 宣告，請更新修補");
        return { contents: src.replace(marker, marker + "\n(globalThis as any).__ondenTxStorage = txStorage;"), loader: "ts" };
      });
    },
  };
}

/** index.ts 把「組裝 app」與「開機＋啟動伺服器」寫在同一個檔（含 top-level await）。實驗用：把 `// Server bootstrap` 之後整段切掉。
 *  正式做法：拆成 app.ts（組裝）與 server.ts（Node 開機），兩個執行環境各有自己的開機檔（README §1）。 */
export function stripBoot(root) {
  const file = resolve(root, "packages/backend/src/index.ts");
  return {
    name: "strip-boot",
    setup(b) {
      b.onLoad({ filter: /packages\/backend\/src\/index\.ts$/ }, (args) => {
        if (args.path !== file) return;
        const src = readFileSync(file, "utf8");
        const i = src.indexOf("// Server bootstrap");
        if (i < 0) throw new Error("index.ts 變了：找不到 `// Server bootstrap`，請更新修補");
        return { contents: src.slice(0, i), loader: "ts" };
      });
    },
  };
}
