// The bar above the site: which page, how wide, which home page style, the look, the publish
// button and what it says about saving. Every choice is one of the site's own (@onden/site): a
// page style is a set of picks for the two home boxes, the look is 氣質·重點色·配色.
import { useState } from "react";
import { HOME_PRESETS, HOME_PRESET_IDS, STYLE_PRESETS, type HomePresetId, type SiteStyle } from "@onden/site";
import { Button, Link, Popover, Segmented, Select, Switch, usePopover } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { displayTitle } from "../../../lib/noteLabel";
import StyleChoices from "../studio/StyleChoices";
import { copyUrl } from "../copyUrl";
import type { SitePage } from "../SiteRender";
import { presetWord } from "./siteWords";

export type PageKind = SitePage["kind"];
/** The preview widths: 電腦 draws at the screen's width, the others at a fixed one. */
export const WIDTHS = [{ id: "desktop", px: null }, { id: "tablet", px: 768 }, { id: "phone", px: 390 }] as const;
export type WidthId = (typeof WIDTHS)[number]["id"];

type Props = {
  page: PageKind;
  onPage: (page: PageKind) => void;
  width: WidthId;
  onWidth: (width: WidthId) => void;
  preset: HomePresetId | null;
  onPreset: (preset: HomePresetId) => void;
  look: SiteStyle;
  onLook: (look: SiteStyle) => void;
  readerOnly: boolean;
  onReaderOnly: (on: boolean) => void;
  saveText: string | undefined;
  saveStatus: string;
  onRetry: () => void;
  online: boolean;
  publishing: boolean;
  publishLoading: boolean;
  publishUrl: string | null;
  onPublish: () => void;
  /** The old free-form home page is the one drawn: the style select says so until a style is chosen. */
  legacyDrawn: boolean;
  /** Note and tag pages are previewed on a note / a tag of the owner's: a choice among them. */
  sample?: { label: string; value: string; options: Array<{ id: string; title: string }>; onChange: (id: string) => void };
};

function LookButton({ look, onLook }: { look: SiteStyle; onLook: (look: SiteStyle) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  return (
    <>
      <Button ref={pop.anchor} size="sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("Look")}: {STYLE_PRESETS[look.preset].label}
      </Button>
      {open && <Popover popover={pop} label={t("Look")} className="ss-style-pop"><StyleChoices value={look} onChange={onLook} /></Popover>}
    </>
  );
}

export default function SetupBar(p: Props) {
  const t = useT();
  const pages: Array<[PageKind, string]> = [["home", t("Home page")], ["note", t("Note page")], ["tag", t("Tag page")]];
  const widths: Record<WidthId, string> = { desktop: t("Desktop"), tablet: t("Tablet"), phone: t("Phone") };
  return (
    <header className="ss-bar">
      <Segmented label={t("Page")} value={p.page} options={pages.map(([value, label]) => ({ value, label }))} onChange={p.onPage} />
      {p.sample && (
        <label className="ss-bar__group">
          <span className="ss-bar__label">{p.sample.label}</span>
          <Select value={p.sample.value} onChange={(e) => p.sample!.onChange(e.target.value)}>
            {p.sample.options.map((o) => <option key={o.id} value={o.id}>{displayTitle(o.title)}</option>)}
          </Select>
        </label>
      )}
      <Segmented label={t("Width")} value={p.width} options={WIDTHS.map(({ id }) => ({ value: id, label: widths[id] }))} onChange={p.onWidth} />
      <label className="ss-bar__group">
        <span className="ss-bar__label">{t("Home page style")}</span>
        <Select value={p.legacyDrawn ? "legacy" : p.preset ?? "simple"} onChange={(e) => { if (e.target.value !== "legacy") p.onPreset(e.target.value as HomePresetId); }}>
          {p.legacyDrawn && <option value="legacy" disabled>{t("Old free-form page")}</option>}
          {HOME_PRESET_IDS.map((id) => <option key={id} value={id}>{presetWord(HOME_PRESETS[id].label)}</option>)}
        </Select>
      </label>
      <LookButton look={p.look} onLook={p.onLook} />
      <div className="ss-bar__group">
        <Switch on={p.readerOnly} label={t("Show only what readers see")} onChange={p.onReaderOnly} />
        <span className="ss-bar__label">{t("Show only what readers see")}</span>
      </div>
      <div className="ss-bar__group ss-bar__push">
        {p.saveText && (
          <span className="ss-save" data-status={p.saveStatus} role="status" aria-live="polite">
            {p.saveText}
            {p.saveStatus === "error" && <Button size="sm" variant="ghost" onClick={p.onRetry}>{t("Retry saving")}</Button>}
          </span>
        )}
        <Button variant="primary" className="pub-publish-button" disabled={!p.online || p.publishing || p.publishLoading} onClick={p.onPublish}>
          {p.publishing ? t("Publishing…") : p.publishLoading ? "…" : t("Publish")}
        </Button>
        {p.publishUrl && (
          <>
            <Link className="ui-btn ui-btn--secondary" href={p.publishUrl} target="_blank" rel="noreferrer">{t("Open the site")}</Link>
            <Button onClick={() => copyUrl(p.publishUrl!)}>{t("Copy link")}</Button>
          </>
        )}
      </div>
    </header>
  );
}
