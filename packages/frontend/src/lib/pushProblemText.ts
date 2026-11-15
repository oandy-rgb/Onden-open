import { t } from "./i18n";
import type { PushProblem } from "./webPush";

/** One plain sentence for why lock-screen reminders did not turn on, with what to do about it. */
export function pushProblemText(problem: PushProblem): string {
  switch (problem) {
    case "brave":
      return t("Brave keeps Google's push service off by default. In Brave Settings, turn on “Use Google services for push messaging”, then try again.");
    case "blocked":
      return t("Notifications are blocked for this site. Allow them in your browser settings to get lock-screen reminders.");
    case "install":
      return t("On iPhone and iPad, add Onden to your Home Screen first, then turn on reminders from the app.");
    case "failed":
      return t("Could not turn on lock-screen reminders. Check your connection and try again.");
  }
}
