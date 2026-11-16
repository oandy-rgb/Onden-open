// The info panel (NodeInspector → useNoteFunctions) loads each module's 功能 rows with `import()` when it mounts, and shows them
// when they arrive. A test that renders the panel and ends first leaves those imports running, and under load vitest has already
// torn the file's environment down when they ask for their files: "EnvironmentTeardownError: Cannot load … after the environment
// was torn down", an unhandled error that vitest pins on whatever file was running and that fails the whole run.
// A file that renders the panel awaits this once, before its tests: the imports are then already done, and the panel's own calls
// resolve at once.
import { MODULES } from "../../modules";

export async function loadNoteFunctionModules(): Promise<void> {
  await Promise.all(MODULES.map((mod) => mod.noteFunctionRows?.()));
  await import("../../components/infoFunctions");
}
