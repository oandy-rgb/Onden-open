import { t } from "../i18n";
import { makeOnlineOperation } from "./onlineWrite";
import type { DataCtx } from "./types";

/** `value` is null when the save is confirmed but the tag could not be read
 *  back (a later retry repeats only that read). */
export type TagConfigSaveResult<T> = { status: "saved"; value: T | null };
type FunctionResult = { id: string; function_id: string } | { deduped: true };

/** A tag's functions — one reference per function (PUT / DELETE /api/tags/:id/functions/:functionId).
 *  Online decisions through the one online operation (onlineWrite.ts): nothing is queued as an ability
 *  before the server accepts it, a rejected save leaves the page unchanged, a retry reuses the intent's
 *  key. Failures are reported once, by the operation. */
export function makeTagConfigWriter(ctx: DataCtx) {
  const operation = makeOnlineOperation(ctx);

  function save(tagId: string, online: boolean | undefined, method: "PUT" | "DELETE", path: string): Promise<TagConfigSaveResult<FunctionResult>> {
    return operation(`node:${tagId}`, t("Connect to save tag functions."), async (submit) => {
      return { status: "saved" as const, value: (await submit<Exclude<FunctionResult, { deduped: true }>>(path, method === "PUT" ? "{}" : undefined, method)) as FunctionResult };
    }, online);
  }

  return {
    /** Give the tag a function. */
    addFunction(tagId: string, functionId: string, online?: boolean): Promise<TagConfigSaveResult<FunctionResult>> {
      return save(tagId, online, "PUT", `/api/tags/${tagId}/functions/${encodeURIComponent(functionId)}`);
    },
    /** Take a function off the tag. */
    removeFunction(tagId: string, functionId: string, online?: boolean): Promise<TagConfigSaveResult<FunctionResult>> {
      return save(tagId, online, "DELETE", `/api/tags/${tagId}/functions/${encodeURIComponent(functionId)}`);
    },
  };
}
