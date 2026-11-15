import { MODULES, registerModuleEffects } from "../../modules/index.js";

/** Harnesses that mount routers directly skip mountModules; register the
 *  shipped modules' agent tools, outbox effects, tag functions and node hooks
 *  the way the real app does (re-registering the same objects is a no-op). */
export function registerShippedModules(): void {
  for (const mod of MODULES) registerModuleEffects(mod);
}
