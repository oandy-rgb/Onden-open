import { ChevronRight, Type } from "lucide-react";
import { Pressable } from "../components/ui";
import { useT } from "../lib/i18n";
import type { SettingContext } from "../lib/settingsTypes";
import { noteFontName } from "./NoteFontCards";
import { useNoteFont } from "./useNoteFont";

// Settings › Appearance: one row that says which font notes use and opens the 筆記 page,
// where the font is chosen. The app's own text keeps the system font, so the font is not
// an appearance setting; this row is for whoever looks for it here first.
export default function NoteFontLink({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const font = useNoteFont();
  if (!ctx.openTab) return null;
  return (
    <ul className="settings-list">
      <li>
        <Pressable type="button" className="settings-list-row" onClick={() => ctx.openTab?.("notes")}>
          <span className="settings-list-icon" aria-hidden="true"><Type /></span>
          <span className="settings-list-label">{t("Note font")}</span>
          <span className="settings-list-value">{noteFontName(font, t)}</span>
          <ChevronRight size={18} className="settings-list-chevron" aria-hidden="true" />
        </Pressable>
      </li>
    </ul>
  );
}
