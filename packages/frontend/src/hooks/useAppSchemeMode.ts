import { useSyncExternalStore } from "react";
import { isDarkTheme, observeTheme } from "../lib/documentAccess";

export type AppSchemeMode = "light" | "dark";

const modeNow = (): AppSchemeMode => (isDarkTheme() ? "dark" : "light");

/** Onden's own light or dark, as the app resolved it. The one reader: the website
 *  studio's frame and the slides' 「跟網站一樣」 both follow it. */
export function useAppSchemeMode(): AppSchemeMode {
  return useSyncExternalStore(observeTheme, modeNow, () => "light");
}
