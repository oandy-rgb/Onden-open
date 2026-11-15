import { useAppSelector } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { useSpaces } from "../lib/spaces";
import { workspaceZoneOf, zoneName } from "../lib/workspaceTime";
import { useModuleStatus } from "../hooks/useModuleFilter";
import { useUnseenChanges } from "../hooks/useUnseenChanges";
import { inModuleLibrary, MODULES } from "../modules";
import { shownStatus } from "../lib/libraryLayout";
import { useSettingValue } from "./useOption";
import { SETTINGS } from "./registry";
import { colorNameKey } from "./colorNames";
import { useNoteFont } from "./useNoteFont";
import { useNavLayout } from "../lib/navLayoutStore";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePushStatus } from "../lib/webPush";
import { noteFontName } from "./NoteFontCards";
import type { SettingDef } from "../lib/settingsTypes";
import type { TabId } from "../lib/settingsTab";

// What the settings list shows at the right of a row in place of a sentence:
// the current value of what the page holds. Rows without one show nothing. Everything here is read
// from this device: opening Settings asks the server for nothing.

function valueDef(id: string) {
  const def = SETTINGS.find((s) => s.id === id);
  if (!def || def.type !== "enum") throw new Error(`settings list: ${id} is not an enum setting`);
  return def as Extract<SettingDef, { type: "enum" }>;
}
const LANGUAGE = valueDef("language.app");
const THEME = valueDef("theme.mode");
const TEXT_SIZE = valueDef("note.text_size");

/** The value shown at the right of each row, by tab. */
export function useListValues(): Partial<Record<TabId, string>> {
  const t = useT();
  const status = useModuleStatus();
  // Read-only: the shell already loads the spaces; opening Settings asks the server for nothing.
  const { spaces } = useSpaces(false);
  const zone = useAppSelector((s) => workspaceZoneOf(s.data)) ?? "UTC";
  const dayStartHour = useAppSelector((s) => s.data.workspace.day_start_hour ?? 0);
  const language = useSettingValue(LANGUAGE);
  const theme = useSettingValue(THEME);
  const textSize = useSettingValue(TEXT_SIZE);
  const noteFont = useNoteFont();
  const navLayout = useNavLayout().value;
  const phone = useIsMobile();
  const push = usePushStatus();
  const optionLabel = (def: typeof LANGUAGE | typeof THEME | typeof TEXT_SIZE, value: string) => t(def.options.find((o) => o.value === value)?.label ?? "");
  const listed = MODULES.filter(inModuleLibrary);
  const on = listed.filter((m) => shownStatus(m, status) === "on").length;
  return {
    modules: t("{n} of {total} on", { n: on, total: listed.length }),
    spaces: spaces.length > 0 ? t(spaces.length === 1 ? "1 space" : "{n} spaces", { n: spaces.length }) : undefined,
    language: optionLabel(LANGUAGE, language),
    time: t("{zone} · day starts at {hour}", { zone: zoneName(zone), hour: dayStartHour }),
    appearance: `${optionLabel(THEME, theme)} · ${t(colorNameKey())}`,
    notes: `${noteFontName(noteFont, t)} · ${optionLabel(TEXT_SIZE, textSize)}`,
    // Only once the person has arranged the bar: the default count needs the feature list, which Settings does not load.
    navigation: navLayout ? t("{n} pinned", { n: phone ? navLayout.phone : navLayout.order.length }) : undefined,
    notifications: push.available ? t(push.subscribed ? "On" : "Off") : undefined,
  };
}

/** Whether the list marks 「關於」 with a small 「新」: updates not yet read. */
export function useAboutIsNew(): boolean {
  return useUnseenChanges().unseen.length > 0;
}
