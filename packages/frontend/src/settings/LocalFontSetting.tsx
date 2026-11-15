import { useEffect, useRef, useState } from "react";
import { Button, FieldError, Select, TextField } from "../components/ui";
import { useT } from "../lib/i18n";
import { cleanFontName, FONT_NAME_MAX } from "../lib/fontPrefs";
import { isMissingHere } from "../lib/fontApply";
import { canListInstalledFonts, installedFonts } from "../lib/localFonts";
import { useNoteFont } from "./useNoteFont";
import "./LocalFont.css";

// Settings › Notes › 更多 › 電腦裡的其他字型…: a family installed on this computer, typed or
// picked where the browser lists them. Once chosen it is a fifth card of 字體 (not a second
// setting that covers it); another device without the family shows the built-in face and says so.

const SAVE_AFTER_TYPING_MS = 400;

export default function LocalFontSetting() {
  const t = useT();
  const font = useNoteFont();
  const [open, setOpen] = useState(font.customName !== null);
  const [typed, setTyped] = useState(font.customName ?? "");
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [declined, setDeclined] = useState(false);
  // Only what the person typed is saved: a name left over from before another card was chosen is not.
  const typedByPerson = useRef(false);

  // The account's value arrives after the page opened (or changes on another device).
  useEffect(() => {
    typedByPerson.current = false;
    if (font.customName !== null) { setTyped(font.customName); setOpen(true); } else setTyped("");
  }, [font.customName]);
  // Typing saves a moment after the last key, so the preview follows without one write per key.
  useEffect(() => {
    const name = cleanFontName(typed);
    if (!open || !typedByPerson.current || name === "" || name === font.customName) return;
    const timer = setTimeout(() => { typedByPerson.current = false; font.pickCustom(name); }, SAVE_AFTER_TYPING_MS);
    return () => clearTimeout(timer);
  }, [typed, open, font]);

  async function listInstalled() {
    const names = await installedFonts();
    if (names) setInstalled(names); else setDeclined(true);
  }

  if (!open) {
    return <Button variant="secondary" onClick={() => setOpen(true)}>{t("Other fonts on this computer…")}</Button>;
  }
  return (
    <div className="fonts-setting">
      <div className="fonts-setting__custom">
        <TextField value={typed} maxLength={FONT_NAME_MAX} placeholder={t("Font name")} aria-label={t("Font name")}
          onChange={(e) => { typedByPerson.current = true; setTyped(e.target.value); }} />
        {canListInstalledFonts() && !installed && !declined && (
          <Button onClick={() => { void listInstalled(); }}>{t("Pick from installed fonts")}</Button>
        )}
        {installed && (
          <Select aria-label={t("Installed fonts")} value={installed.includes(typed) ? typed : ""}
            onChange={(e) => { setTyped(e.target.value); font.pickCustom(e.target.value); }}>
            <option value="" disabled>{t("Choose a font")}</option>
            {installed.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        )}
        {declined && <p className="fonts-setting__note">{t("This browser didn't share the list of installed fonts. Type the name instead.")}</p>}
        {font.customName !== null && isMissingHere({ mode: "custom", name: font.customName }) && (
          <FieldError>{t("This device doesn't have this font, so it's using the default font.")}</FieldError>
        )}
      </div>
      <p className="fonts-setting__note">
        {t("Fonts differ between devices. If a device doesn't have your font, it uses the default one, and your choice stays for the devices that do.")}
      </p>
    </div>
  );
}
