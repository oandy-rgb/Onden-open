import { useState } from "react";
import type { Tag } from "../../../lib/api";
import { noteWriter } from "../../../lib/data";
import { useFunctions } from "../../../hooks/useFunctions";
import { useT } from "../../../lib/i18n";
import { useModuleStatus } from "../../../hooks/useModuleFilter";
import { useModuleImportConfirm } from "../../ModuleImportConfirm";
import { useSchemaDraft } from "./useSchemaDraft";

/** What the owner changes about a tag's structure, and the state around it.
 *
 *  - `draft`: fields and behaviour (see useSchemaDraft).
 *  - Functions (hooks/useFunctions): `removeFunction` takes off what the tag itself holds,
 *    `turnOnFunction` turns on the module of a function the tag already
 *    holds — asking once first when the module waits for the owner's yes.
 *    The writers report failures; these only resolve.
 *  - `moveUnder`: the parent.
 *  - `busy` is true while any of these runs; `changeDisabled` adds offline.
 *    `message` is the one status line under the functions.
 *  - `onFunctionRemoved(id)` lets the page close what showed that function.
 *
 *  Every function change submits the waiting schema draft first, so a change
 *  never overtakes a field edit. Example:
 *    const structure = useTagStructure({ tag, online, onSaved });
 *    await structure.removeFunction("review"); */
export function useTagStructure({ tag, online, onSaved, onFunctionRemoved }: {
  tag: Tag; online: boolean; onSaved?: () => void; onFunctionRemoved?: (id: string) => void;
}) {
  const t = useT();
  const [abilityMessage, setAbilityMessage] = useState<string | null>(null);
  const draft = useSchemaDraft({
    tag, online, onSaved,
    onLoadError: () => setAbilityMessage(t("Could not load this tag's settings. Reopen this tag to retry.")),
  });
  const [abilityBusy, setAbilityBusy] = useState(false);
  const functionActions = useFunctions({ kind: "node", id: tag.id }, { online, onChanged: onSaved });
  const importer = useModuleImportConfirm();
  const moduleStatus = useModuleStatus();

  /** Take off the function reference this tag holds (a module tag's own function stays): flush the open draft first. */
  async function removeFunction(id: string) {
    setAbilityBusy(true);
    setAbilityMessage(null);
    await draft.flush();
    await functionActions.remove(id);
    onFunctionRemoved?.(id);
    setAbilityBusy(false);
  }

  /** 「開啟」 on a function the tag already holds: turn its module on (one Undo
   *  on the toast). A module that waits for the owner's
   *  one-time yes (semantic search, RSS, website) asks first; the rest do not. */
  async function turnOnFunction(id: string) {
    const run = async () => {
      setAbilityBusy(true);
      setAbilityMessage(null);
      try {
        await draft.flush();
        return await functionActions.add(id, { confirmed: true, tagName: tag.name });
      } finally { setAbilityBusy(false); }
    };
    if (moduleStatus(id) !== "ask") { await run(); return; }
    await importer.confirm(id, { run });
  }

  /** 「上層」: put this tag under another tag (or at the top). Notes are never
   *  offered: the tag tree and the note tree are separate (T12; the server
   *  refuses one with 409 parent_kind_mismatch). */
  async function moveUnder(parentId: string | null) {
    setAbilityBusy(true);
    try {
      await noteWriter.patch(tag.id, { parent_id: parentId });
      await onSaved?.();
    } catch { /* the writer reported it */ }
    finally { setAbilityBusy(false); }
  }

  const savingLabel = t(abilityBusy || draft.status === "saving" ? "Saving…" :
    draft.status === "error" ? "Save failed" : draft.status === "queued" ? "Waiting to sync" : "Saved");
  // The title row's quiet version (the note page's rule): only a save in
  // progress or a problem shows; a saved state says nothing.
  const savingNotice = abilityBusy || draft.status === "saving" || draft.status === "error" || draft.status === "queued" ? savingLabel : "";

  return {
    draft, busy: abilityBusy, changeDisabled: !online || abilityBusy, message: abilityMessage,
    savingLabel, savingNotice,
    /** The id of the function whose module is being changed, or null. */
    functionBusy: functionActions.busy,
    removeFunction, turnOnFunction, moveUnder,
    /** The one-time confirmation to render once on the page. */
    importerElement: importer.element,
  };
}
