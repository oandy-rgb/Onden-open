// How the status page's 「分組」 section groups cards, kept for the account (lib/accountPrefStore,
// pref key "reviewGroupBy"): by tag or by note. The same choice on every screen.

import { createAccountPref } from "../../lib/accountPrefStore";
import { PREFS } from "../../lib/prefs";

export type ReviewGroupBy = "tag" | "note";

const parseReviewGroupBy = (value: unknown): ReviewGroupBy | null => value === "tag" || value === "note" ? value : null;

export const reviewGroupByPref = createAccountPref<ReviewGroupBy>({
  serverKey: "reviewGroupBy",
  follows: "account", // a way of looking at cards, not a layout: the same wherever they sign in
  copy: PREFS.reviewGroupBy,
  parse: parseReviewGroupBy,
});
