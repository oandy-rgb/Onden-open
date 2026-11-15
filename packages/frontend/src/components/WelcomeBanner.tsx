import { useState } from "react";
import { Sparkles, X, PenLine, CalendarDays, Boxes, Check, Loader2, BookOpen } from "lucide-react";
import { getLocale, setLocalePref, useT, type AppLocale } from "../lib/i18n";
import { STARTER_PACKS, localizeStarterPack } from "../data/starterPacks";
import "./WelcomeBanner.css";
import { sampleNotesWereMade } from "../lib/firstRunLanding";
import { Button, Link, Pressable } from "./ui";

// First-run hello. A new workspace lands on a blank daily note with no
// orientation; this one-time, dismissible card names the core loop (capture →
// task → daily-note → link) and — crucially — drops the user straight INTO it:
// every button is a single click into the real flow (write a note, open today,
// or opt in to a starter pack so Onden isn't an empty void). It's an inline
// card, NOT a modal wizard — no steps, nothing to configure, nothing seeded
// without an explicit click. Gated by the host on the account's "welcome"
// hint (hooks/useHintOnce) — shown once per account, never nags.
// ([[surface-no-programmer-ui]]: ordinary words, no jargon, no modal wall.)

type Props = {
  /** Land the user in the editor on a fresh note (capture rail). */
  onCreateNote: () => void;
  /** Open (or create) today's daily note — the sticky daily-driver entry. */
  onOpenToday: () => void;
  /** Opt-in: install ONE starter pack so the workspace shows shape, not a
   *  blank void. Resolves true on success. Tags stay ordinary + deletable. */
  onInstallStarter: (pack: unknown, label: string) => Promise<boolean>;
  /** Opt-in: BUILD the user's first website — creates the intro notes in a
   *  space that publishes, applies the site chrome, publishes, focuses Home.
   *  Resolves the published `/site/...` URL (null when nothing was published,
   *  the reason shown) so the card can link to it. */
  onBuildSite: () => Promise<string | null>;
  /** Dismiss for good (persisted by the host). */
  onDismiss: () => void;
  /** Network gate — starter / intro install hits the API. */
  online?: boolean;
  /** Only the language choice (the browser app's first open, which already has sample notes). */
  languageOnly?: boolean;
};

// The single starter pack offered on first run. Keeping it to one keeps the
// card calm (one optional "see it populated" button, not a six-tile menu —
// that lives in Settings ▸ Your Data for anyone who wants the full set).
const FIRST_RUN_PACK = STARTER_PACKS[0]; // 📚 Book — a relatable reading-log schema.

// Each language is named in itself, so it can be found whatever language the screen is in now.
const LANGUAGES: ReadonlyArray<{ value: AppLocale; label: string }> = [
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
];

/** 介面語言 as a first-run choice: starts on what the browser asks for, and picking is the same preference as Settings › Language. */
function LanguageChoice() {
  const t = useT();
  const shown = getLocale();
  return (
    <div className="welcome-banner-language">
      <span className="welcome-banner-language-label" id="welcome-language-label">{t("Interface language")}</span>
      <div role="radiogroup" aria-labelledby="welcome-language-label" className="welcome-banner-language-choices">
        {LANGUAGES.map((language) => (
          <Button key={language.value} role="radio" aria-checked={shown === language.value} variant={shown === language.value ? "primary" : "secondary"}
            onClick={() => setLocalePref(language.value)}>
            {language.label}
          </Button>
        ))}
      </div>
      {sampleNotesWereMade() && (
        <p className="welcome-banner-language-note">{t("The sample notes are written in Chinese; this setting changes the menus and buttons.")}</p>
      )}
    </div>
  );
}

export default function WelcomeBanner({ onCreateNote, onOpenToday, onInstallStarter, onBuildSite, onDismiss, online = true, languageOnly = false }: Props) {
  const t = useT();
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [building, setBuilding] = useState(false);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);

  async function handleInstall() {
    if (!FIRST_RUN_PACK || installing || installed) return;
    setInstalling(true);
    const ok = await onInstallStarter(localizeStarterPack(FIRST_RUN_PACK), FIRST_RUN_PACK.label);
    setInstalling(false);
    if (ok) setInstalled(true);
  }

  async function handleBuildSite() {
    if (building || siteUrl) return;
    setBuilding(true);
    const url = await onBuildSite();
    setBuilding(false);
    if (url) setSiteUrl(url);
  }

  return (
    <div className="welcome-banner" role="note">
      <div className="welcome-banner-icon"><Sparkles size={18} /></div>
      <div className="welcome-banner-body">
        <h2 className="welcome-banner-title">{t("Welcome to Onden")}</h2>
        {!languageOnly && <p className="welcome-banner-text">
          {t("Capture a thought, give it shape with tags, then connect ideas on a canvas. Everything stays local and yours.")}
        </p>}
        <LanguageChoice />
        {!languageOnly && <div className="welcome-banner-actions">
          <Pressable className="welcome-banner-action" onClick={onCreateNote}>
            <PenLine size={14} /> {t("Write your first note")}
          </Pressable>
          <Pressable className="welcome-banner-action welcome-banner-action--ghost" onClick={onOpenToday}>
            <CalendarDays size={14} /> {t("Open today's note")}
          </Pressable>
          {FIRST_RUN_PACK && (
            <Pressable
              className="welcome-banner-action welcome-banner-action--ghost"
              onClick={() => void handleInstall()}
              disabled={installing || installed || !online}
              title={installed
                ? t("Added — find it in the tag panel; delete the tag any time.")
                : t("Adds one example tag so you can see Onden in use. Remove it any time.")}
            >
              {installed
                ? <><Check size={14} /> {t("Added a starter tag")}</>
                : installing
                  ? <><Loader2 size={14} className="welcome-banner-spin" /> {t("Adding…")}</>
                  : <><Boxes size={14} /> {t("Add a starter tag to see it in use")}</>}
            </Pressable>
          )}
          <Pressable
            className="welcome-banner-action welcome-banner-action--ghost"
            onClick={() => void handleBuildSite()}
            disabled={building || !!siteUrl || !online}
            title={siteUrl
              ? t("Published — every page is an ordinary note you can edit or delete; readers see your changes after the next Publish on the Website screen.")
              : t("Turns a few interlinked intro notes into a real published website — the fastest way to see what Onden does. Edit or delete them any time.")}
          >
            {siteUrl
              ? <><Check size={14} /> {t("Your site is live")}</>
              : building
                ? <><Loader2 size={14} className="welcome-banner-spin" /> {t("Building your site…")}</>
                : <><BookOpen size={14} /> {t("Build your first website")}</>}
          </Pressable>
        </div>}
        {siteUrl && (
          <p className="welcome-banner-note">
            {t("You just built a website from notes.")}{" "}
            <Link className="welcome-banner-sitelink" href={siteUrl} target="_blank" rel="noopener noreferrer">
              {t("View your published site →")}
            </Link>
          </p>
        )}
        {installed && (
          <p className="welcome-banner-note">
            {t("Done — open the tag panel to use it, or delete the tag any time. It's just an ordinary tag.")}
          </p>
        )}
      </div>
      <Pressable className="welcome-banner-dismiss" title={t("Dismiss")} aria-label={t("Dismiss")} onClick={onDismiss}>
        <X size={15} />
      </Pressable>
    </div>
  );
}
