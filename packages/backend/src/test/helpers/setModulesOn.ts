import { q } from "../../db.js";
import { isConfirmOnceModule, libraryModuleIds } from "../../services/workspaceModules.js";
import { registerShippedModules } from "./registerShippedModules.js";

/** Put a test workspace in a known module state: only `on` are on (null: every
 *  module is on and every confirm-once module agreed to). Written as the owner's
 *  decisions the library stores (modules_off / modules_confirmed), so tests
 *  state "only these are on" without spelling out the storage. */
export async function setModulesOn(workspaceId: string, on: readonly string[] | null): Promise<void> {
  registerShippedModules();
  const all = libraryModuleIds();
  const off = on === null ? [] : all.filter((id) => !on.includes(id));
  const confirmed = all.filter((id) => isConfirmOnceModule(id) && (on === null || on.includes(id)));
  await q(`UPDATE workspaces SET modules_off = $2::jsonb, modules_confirmed = $3::jsonb WHERE id = $1`,
    [workspaceId, JSON.stringify(off), JSON.stringify(confirmed)]);
}

/** Turn one module on in a test workspace and leave the rest as they are: off
 *  no more, and agreed to when it is a confirm-once module (ai, rss…), as if
 *  the owner had said yes once. */
export async function turnModuleOn(workspaceId: string, id: string): Promise<void> {
  registerShippedModules();
  await q(
    `UPDATE workspaces
        SET modules_off = COALESCE(modules_off, '[]'::jsonb) - $2::text,
            modules_confirmed = CASE WHEN $3::boolean AND NOT COALESCE(modules_confirmed, '[]'::jsonb) ? $2::text
                                     THEN COALESCE(modules_confirmed, '[]'::jsonb) || jsonb_build_array($2::text)
                                     ELSE modules_confirmed END
      WHERE id = $1`,
    [workspaceId, id, isConfirmOnceModule(id)]);
}
