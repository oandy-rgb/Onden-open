import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { appHeadPlugin } from "./src/appShell/vitePlugin";

// Capacitor build — standalone React SPA, separate from Astro
export default defineConfig({
  plugins: [appHeadPlugin("capacitor"), react(), tailwindcss()],
  // @onden/markdown is read from source (the backend image alone builds its dist).
  resolve: { alias: {
    // The subpath entries first: an alias matches by prefix, and the local-DB
    // worker may import only these (test/workerImports.test.ts).
    "@onden/markdown/slug": fileURLToPath(new URL("../markdown/src/slug.ts", import.meta.url)),
    "@onden/markdown/task-parse": fileURLToPath(new URL("../markdown/src/taskParse.ts", import.meta.url)),
    "@onden/markdown/ink": fileURLToPath(new URL("../markdown/src/ink.ts", import.meta.url)),
    "@onden/markdown/page-text": fileURLToPath(new URL("../markdown/src/pageText.ts", import.meta.url)),
    "@onden/markdown/page-images": fileURLToPath(new URL("../markdown/src/pageImages.ts", import.meta.url)),
    "@onden/markdown/snippet": fileURLToPath(new URL("../markdown/src/snippet.ts", import.meta.url)),
    "@onden/markdown/contract": fileURLToPath(new URL("../markdown/src/sharedContract.ts", import.meta.url)),
    "@onden/markdown": fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)),
  } },
  envPrefix: ["VITE_", "PUBLIC_"],
  define: {
    "import.meta.env.VITE_NATIVE": JSON.stringify("true"),
    __ONDEN_BUILT_AT__: Date.now(), // lib/buildTime
  },
  build: {
    outDir: "dist-cap",
    emptyOutDir: true,
  },
});
