// Writes fullstack/generated/hostContract.json: the few values the Playwright specs need from the
// workspace packages (the client protocol header, the default site design). Run on the HOST by run.sh
// and by `npm run check:specs`; the specs read the JSON through fullstack/hostContract.ts and import
// nothing from packages/*, because the runner container mounts only e2e/ (see e2e/README.md).
// Run with the repo's tsx and the site tsconfig, whose `paths` resolve @onden/markdown to its source:
//   npx tsx --tsconfig ../site/tsconfig.json e2e/scripts/writeHostContract.ts   (from packages/frontend)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "../../../markdown/src/sharedContract.ts";
import { defaultDesign } from "../../../site/src/designV3.ts";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../fullstack/generated/hostContract.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ clientProtocol: CLIENT_PROTOCOL, clientProtocolHeader: CLIENT_PROTOCOL_HEADER, defaultDesign: defaultDesign() }, null, 2) + "\n");
console.log(`wrote ${out}`);
