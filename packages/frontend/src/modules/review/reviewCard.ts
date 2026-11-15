import type { ReviewCardChange } from "@onden/contract";
import { addToast } from "../../lib/appStore";
import { isBrowserOnline } from "../../lib/browserNetwork";
import { sendWrite, writeErrors } from "../../lib/data";
import { t } from "../../lib/i18n";
import { rememberNoteReviewCard } from "./noteCardStatus";

/** Make a whole note a review card (`on`) or stop. Needs a connection: the change is the shared note's, so it is saved or refused by the
 *  server (nothing is queued). True once the server accepted it; a refusal was reported to the person. */
export async function setNoteReviewCard(noteId: string, on: boolean): Promise<boolean> {
  if (!isBrowserOnline()) { addToast(t("Making a note a review card needs a connection. Try again once you are online."), "error"); return false; }
  try {
    const result = await sendWrite<ReviewCardChange>(on ? "PUT" : "DELETE", `/api/review/cards/${noteId}`);
    rememberNoteReviewCard(noteId, on);
    addToast(on
      ? (result.changed ? t("This note is a review card now.") : t("This note already is a review card."))
      : (result.changed ? t("This note is no longer a review card. Your schedule is kept." ) : t("This note was not a review card.")), "success");
    return true;
  } catch (error) {
    writeErrors.report(error, addToast);
    return false;
  }
}

/** Make each of these notes a review card; a note that already is one is left as it is. Quiet: the caller says what happened. Notes
 *  the server does not have yet (made while offline) count as failed, so running the caller again finishes them. */
export async function makeReviewCards(noteIds: readonly string[]): Promise<{ changed: number; failed: number }> {
  let changed = 0, failed = 0;
  for (const id of noteIds) {
    try { if ((await sendWrite<ReviewCardChange>("PUT", `/api/review/cards/${id}`)).changed) changed++; } catch { failed++; }
  }
  return { changed, failed };
}
