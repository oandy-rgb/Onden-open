import { useCallback, useState } from "react";

/** The day a day page shows: the one the person picked, else today — so a page left open past midnight
 *  moves to the new day by itself (a picked day stays until they pick another). `recall` / `remember`
 *  keep the pick while a note is open from the page (pickedDay.ts, today/todayPickedDay.ts). */
export function useShownDay(today: string, recall: (today: string) => string, remember: (date: string, today: string) => void): [string, (date: string) => void] {
  const [own, setOwn] = useState<string | null>(() => { const kept = recall(today); return kept === today ? null : kept; });
  const pick = useCallback((date: string) => { remember(date, today); setOwn(date === today ? null : date); }, [remember, today]);
  return [own ?? today, pick];
}
