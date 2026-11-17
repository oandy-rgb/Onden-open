import { addToast } from "../../lib/appStore";
import { aiRoleWriter, reads, writeErrors } from "../../lib/data";
import { changeModuleImport } from "../../lib/moduleLibrary";
import { t } from "../../lib/i18n";
import { confirmDialog } from "../../components/ConfirmDialog";
import { refreshSpaces } from "../../lib/spaces";
import type { AiConnectionInput, AiMonthlyCap, SetUpAiRequest } from "@onden/contract";
import { apiSettingsBody, type ApiSettings } from "./ApiSettingsFields";
import type { KeyConnection, CodeConnection } from "./model";

// The writes of 設定 › AI, in one place: each is one thing the owner asked for (keep a key, make an AI, take a
// key away…), says its own failure through writeErrors, and answers whether it took. The old key and AI blocks in
// 「空間與成員」 call the same ones.

/** The monthly limit as the server takes it. */
export const capOf = (settings: ApiSettings): AiMonthlyCap => apiSettingsBody(settings).cap;

/** Make an AI with the connection it runs on, in one step: nothing is left half made when a step is refused. The
 *  AI starts suggest-only and stands (可編輯) only in spaces that already let AI read; this never opens one.
 *  `idemKey`: the same for a retry of the same form, so a lost reply cannot make two. */
export async function createAiWithConnection(request: SetUpAiRequest, idemKey: string): Promise<CreatedAi | null> {
  try {
    const made = await aiRoleWriter.create(request, idemKey);
    await refreshSpaces();
    // A retry of a request the server already carried out answers `deduped` and nothing else: the AI exists, but the
    // reply that held its connection code is gone. Say so; never treat it as "made just now".
    return "deduped" in made ? { deduped: true, token: null, actorId: null } : { deduped: false, token: made.token, actorId: made.actor_id };
  } catch (error) { writeErrors.report(error, addToast); return null; }
}
/** What the page needs from a made AI: whether this was a replay, and the connection code (shown once) if there is one. */
export type CreatedAi = { deduped: boolean; token: string | null; actorId: string | null };

export const apiConnection = (credentialId: string, settings: ApiSettings): AiConnectionInput =>
  ({ kind: "api", credential_id: credentialId, model: settings.model, cap: capOf(settings) });

/** Keep a key without an AI to use it. Answers the saved key's id, or null (reported). */
export async function saveKey(fields: Record<string, unknown>, idemKey: string): Promise<{ id: string | null } | null> {
  try {
    const saved = await aiRoleWriter.saveKey(fields, idemKey);
    // A replay (`deduped`) carries no key id: the caller finds the key it already saved (findSavedKey).
    return { id: "credential" in saved && saved.credential ? saved.credential.id : null };
  } catch (error) { writeErrors.report(error, addToast); return null; }
}

/** The kept key with this name, newest first: for a replay of "save the key", which answers without its id. */
export async function findSavedKey(label: string): Promise<string | null> {
  try {
    const list = (await reads.aiRuntime.credentials<{ id: string; label: string; revoked_at: string | null; created_at: string }>()).credentials
      .filter((k) => !k.revoked_at && k.label === label).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return list[0]?.id ?? null;
  } catch { return null; }
}

/** Point an AI at a kept key and a model (PUT runtime): what 「換連線」 and the model fields both do. */
export async function setAiKey(actorId: string, credentialId: string, settings: ApiSettings): Promise<boolean> {
  try {
    await aiRoleWriter.setRuntime(actorId, { default_runtime: "api", api: { ...apiSettingsBody(settings), credential_id: credentialId } });
    return true;
  } catch (error) { writeErrors.report(error, addToast); return false; }
}

/** Let an AI be reached by the owner's own AI with a connection code: the code (shown once) or null (reported). */
export async function giveCode(actorId: string, name: string, alreadyViaCode: boolean, idemKey: string): Promise<string | null> {
  try {
    if (!alreadyViaCode) await aiRoleWriter.useConnectionCode(actorId);
    const minted = await aiRoleWriter.mintCode(actorId, { name, access: "write" }, idemKey);
    if ("token" in minted && minted.token) return minted.token;
    addToast(t("The connection code was already made, but its reply was lost, so it can't be shown again. Revoke it and make a new one."), "error");
    return null;
  } catch (error) { writeErrors.report(error, addToast); return null; }
}

/** Take a key away, after asking. The AIs that run on it stay and are shown as off until given another connection. */
export async function deleteKey(key: Pick<KeyConnection, "id" | "label">): Promise<boolean> {
  if (!(await confirmDialog(t("Delete the key “{name}”? AIs that run on it stop until you give them another connection.", { name: key.label }), { confirmLabel: t("Delete"), danger: true }))) return false;
  try { await aiRoleWriter.deleteKey(key.id); return true; }
  catch (error) { writeErrors.report(error, addToast); return false; }
}

/** Stop a connection code without asking (the caller's own button was the ask). */
export async function revokeCodeNow(code: Pick<CodeConnection, "id" | "actorId">): Promise<boolean> {
  try { await aiRoleWriter.revokeCode(code.actorId, code.id); return true; }
  catch (error) { writeErrors.report(error, addToast); return false; }
}

/** Stop a connection code, after asking: the AI stays, only that code stops working. */
export async function revokeCode(code: Pick<CodeConnection, "id" | "actorId" | "name">): Promise<boolean> {
  const name = code.name || t("Code without a name");
  if (!(await confirmDialog(t("Revoke the connection code “{name}”? The AI stays, but whatever uses this code loses access until you make another.", { name }), { confirmLabel: t("Revoke code"), danger: true }))) return false;
  return revokeCodeNow(code);
}

/** Remove an AI altogether, after asking: its keys stop and it leaves every space. */
export async function deleteAi(ai: { id: string; name: string }): Promise<boolean> {
  if (!(await confirmDialog(t("Remove {name}? Its connection codes stop working and it leaves every space.", { name: ai.name }), { confirmLabel: t("Remove"), danger: true }))) return false;
  try { await aiRoleWriter.remove(ai.id); await refreshSpaces(); return true; }
  catch (error) { writeErrors.report(error, addToast); return false; }
}

/** Test a kept key. Answers how many models it lists, or the plain reason it did not work. */
export async function testKey(keyId: string): Promise<{ ok: true; models: number } | { ok: false; message: string }> {
  try { return { ok: true, models: (await reads.aiRuntime.testStoredCredential(keyId)).models.length }; }
  catch (error) { return { ok: false, message: writeErrors.requestMessage(error, t("The test did not work. Check the address and the key.")) }; }
}

/** AI is a feature the owner turns on once; making the first AI is that yes. */
export async function ensureAiModuleOn(isOn: boolean, online: boolean): Promise<void> {
  if (isOn) return;
  try { await changeModuleImport("ai", true, online); } catch { /* reported by the module writer; the AI is made and the Features page can turn it on */ }
}
