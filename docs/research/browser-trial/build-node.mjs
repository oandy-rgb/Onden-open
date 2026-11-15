// 把「真正的後端 app＋試用版入口」打包成一個檔，`pg` 換成 pgShim.mjs。platform=node：證明「只換 pg 與遷移來源就能跑」。
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationsPlugin, exposeTxStorage } from "./esbuild-plugins.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
await build({
  entryPoints: [resolve(here, "src/entry.ts")],
  outfile: resolve(here, "dist/backend-node.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning",
  alias: { pg: resolve(here, "pgShim.mjs") },
  plugins: [migrationsPlugin(root), exposeTxStorage(root)],
  external: ["sharp", "@electric-sql/pglite*", "pagefind", "pg-native", "cpu-features", "ssh2"],
  banner: { js: "import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);" },
  nodePaths: [resolve(root, "node_modules"), resolve(here, "node_modules")],
});
console.log("ok");
