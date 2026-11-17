import type { ReviewCardChange } from "@onden/contract";
import { sendWrite } from "./onlineWrite";

/** Make a whole note a review card (`on`) or stop. Online only; `changed` says whether the server had anything to change. */
export const reviewCardWriter = {
  set: (noteId: string, on: boolean) => sendWrite<ReviewCardChange>(on ? "PUT" : "DELETE", `/api/review/cards/${noteId}`),
};
