// Values the specs need from the workspace packages, read from the JSON that scripts/writeHostContract.ts
// generates on the host. Specs must not import packages/* (the runner container mounts only e2e/);
// `npm run check:specs` fails when one does.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type HostContract = { clientProtocol: number; clientProtocolHeader: string; defaultDesign: Record<string, unknown> & { boxes: Record<string, unknown> } };

const file = join(__dirname, "generated", "hostContract.json");
let parsed: HostContract;
try {
  parsed = JSON.parse(readFileSync(file, "utf8")) as HostContract;
} catch {
  throw new Error(`${file} is missing: run \`npm run gen:contract\` in packages/frontend (run.sh does this itself).`);
}

export const HOST_CONTRACT: Readonly<HostContract> = parsed;
export const E2E_CLIENT_PROTOCOL = parsed.clientProtocol;
export const E2E_CLIENT_PROTOCOL_HEADER = parsed.clientProtocolHeader;
/** @onden/site's `defaultDesign()` as of this run's source. */
export const hostDefaultDesign = (): HostContract["defaultDesign"] => structuredClone(parsed.defaultDesign);
