import type { SettingDef, SettingContext } from "../lib/settingsTypes";
import { useOption } from "./useOption";
import { Suspense, useState } from "react";
import { useT } from "../lib/i18n";
import { isEnterKey } from "../lib/keys";
import { Button, ChoiceCards, FieldError, RangeInput, Segmented, Select, Switch, TextField } from "../components/ui";
import type { LucideIcon } from "lucide-react";

// Registry defs keep canonical ENGLISH strings; every row translates at
// render time via useT() (gettext-style, lib/i18n.ts) — so the whole
// settings surface localizes without touching a single registry entry.

type RowProps = { def: SettingDef; ctx: SettingContext; titled?: boolean };

/** Hidden behind "Show advanced settings" in this context. */
export function isAdvanced(def: SettingDef, ctx: SettingContext): boolean {
  return typeof def.advanced === "function" ? def.advanced(ctx) : def.advanced === true;
}

/** Settings search: the query's words all appear in the setting's label,
 *  description, section, options, keywords or tab name, in English or as
 *  shown (`tr`). */
export function settingMatches(def: SettingDef, query: string, tabLabel: string, tr: (s: string) => string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const texts = [def.label, def.description, def.hint, def.section, tabLabel,
    ...(def.type === "enum" ? def.options.map((o) => o.label) : [])]
    .filter((x): x is string => !!x);
  const haystack = [...texts, ...texts.map(tr), ...(def.keywords ?? [])].join("\n").toLowerCase();
  return words.every((w) => haystack.includes(w));
}

function BoolRow({ def }: { def: Extract<SettingDef, { type: "boolean" }> }) {
  const [value, setValue] = useOption(def);
  const t = useT();
  return (
    <div className="settings-row">
      <span className="settings-label">{t(def.label)}</span>
      <Switch on={value} label={t(def.label)} onChange={setValue} />
    </div>
  );
}

/** A range input with an icon at each end (small / large) in place of words. */
function SliderRow({ label, ends, min, max, step, value, onChange, valueLabel }: {
  label: string; ends: readonly [LucideIcon, LucideIcon]; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
  /** The current value in words, shown beside the name. */
  valueLabel?: string;
}) {
  const [Low, High] = ends;
  return (
    <div className="settings-slider-block">
      <div className="settings-row">
        <span className="settings-label">{label}</span>
        {valueLabel && <span className="settings-slider-value">{valueLabel}</span>}
      </div>
      <div className="settings-row settings-row--slider">
        <Low size={14} aria-hidden="true" className="settings-slider-end" />
        <RangeInput className="settings-slider" aria-label={label} min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))} />
        <High size={20} aria-hidden="true" className="settings-slider-end" />
      </div>
    </div>
  );
}

function NumberRow({ def }: { def: Extract<SettingDef, { type: "number" }> }) {
  const [value, setValue] = useOption(def);
  const t = useT();
  if (def.control) {
    return <SliderRow label={t(def.label)} ends={def.control.slider} min={def.min ?? 0} max={def.max ?? 100} step={def.step ?? 1}
      value={value} onChange={setValue} />;
  }
  return (
    <div className="settings-row">
      <span className="settings-label">{t(def.label)}</span>
      <TextField
        type="number"
        aria-label={t(def.label)}
        className="settings-input settings-input--narrow"
        value={value}
        min={def.min}
        max={def.max}
        step={def.step ?? 1}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) setValue(n);
        }}
      />
      {def.unit && <span className="settings-unit">{def.unit}</span>}
    </div>
  );
}

function TextRow({ def, ctx }: { def: Extract<SettingDef, { type: "text" }>; ctx: SettingContext }) {
  const [persisted, setPersisted] = useOption(def);
  // Draft buffer so typing doesn't fire side effects on every keystroke when
  // an action button exists; without action, blur saves.
  const [draft, setDraft] = useState(persisted);
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const t = useT();
  return (
    <>
    <div className="settings-row settings-row--input">
      <TextField
        className="settings-input"
        type={def.secret ? "password" : "text"}
        aria-label={t(def.label)}
        value={draft}
        placeholder={def.placeholder && t(def.placeholder)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (!def.action) setPersisted(draft); }}
        onKeyDown={(e) => {
          if (isEnterKey(e) && def.action) {
            void runAction();
          }
        }}
      />
      {def.action && (
        <Button
          variant="primary"
          disabled={running}
          onClick={() => void runAction()}
        >
          {t(def.action.label)}
        </Button>
      )}
    </div>
    {actionError && <FieldError>{actionError}</FieldError>}
    </>
  );

  async function runAction(): Promise<void> {
    if (!def.action) return;
    setRunning(true);
    setActionError(null);
    try {
      setPersisted(draft);
      setActionError((await def.action.run(draft, ctx)) || null);
    } finally {
      setRunning(false);
    }
  }
}

function EnumRow({ def }: { def: Extract<SettingDef, { type: "enum" }> }) {
  const [value, setValue] = useOption(def);
  const t = useT();
  const { control } = def;
  if (control && "swatches" in control) {
    return (
      <ChoiceCards label={t(def.label)} value={value}
        options={def.options.map((o) => ({
          value: o.value,
          label: t(o.label),
          // Each half is drawn with the tokens of the theme it stands for.
          sample: <span className="settings-theme-sample">{(o.value === "system" ? ["light", "dark"] : [o.value, o.value]).map((half, i) => <i key={i} data-theme={half} />)}</span>,
        }))}
        onChange={setValue} />
    );
  }
  if (control && "cards" in control) {
    return (
      <ChoiceCards label={t(def.label)} value={value}
        options={def.options.map((o) => {
          const Icon = control.cards[o.value];
          return { value: o.value, label: t(o.label), sample: Icon && <Icon size={22} /> };
        })}
        onChange={setValue} />
    );
  }
  if (control && "segmented" in control) {
    return (
      <div className="settings-segmented-block">
        <span className="settings-label">{t(def.label)}</span>
        <Segmented label={t(def.label)} value={value} options={def.options.map((o) => ({ value: o.value, label: t(o.label) }))} onChange={setValue} />
      </div>
    );
  }
  if (control) {
    const index = Math.max(0, def.options.findIndex((o) => o.value === value));
    return <SliderRow label={t(def.label)} ends={control.slider} min={0} max={def.options.length - 1} step={1}
      value={index} valueLabel={t(def.options[index]!.label)} onChange={(i) => setValue(def.options[i]!.value)} />;
  }
  return (
    <div className="settings-row">
      <span className="settings-label">{t(def.label)}</span>
      <Select
        className="settings-input"
        aria-label={t(def.label)}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      >
        {def.options.map((o) => (
          <option key={o.value} value={o.value}>{t(o.label)}</option>
        ))}
      </Select>
    </div>
  );
}

function ActionRow({ def, ctx }: { def: Extract<SettingDef, { type: "action" }>; ctx: SettingContext }) {
  const [runningIdx, setRunningIdx] = useState<number | null>(null);
  const t = useT();
  return (
    <div className="settings-row settings-row--actions">
      {def.buttons.map((b, i) => (
        <Button
          key={b.label}
          variant={b.variant === "ghost" ? "secondary" : "primary"}
          disabled={runningIdx !== null}
          onClick={async () => {
            setRunningIdx(i);
            try { await b.run(ctx); } finally { setRunningIdx(null); }
          }}
        >
          {b.icon}{t(b.label)}
        </Button>
      ))}
    </div>
  );
}

function CustomRow({ def, ctx }: { def: Extract<SettingDef, { type: "custom" }>; ctx: SettingContext }) {
  const t = useT();
  const Component = def.component;
  // A module loads its settings widgets on demand (modules/README, boot budget).
  return <Suspense fallback={<p className="setting-note">{t("Loading…")}</p>}><Component ctx={ctx} /></Suspense>;
}

export function SettingRow({ def, ctx, titled = false }: RowProps) {
  const t = useT();
  // `show` is evaluated synchronously; settings dependent on rapidly-changing
  // state should use a custom widget instead.
  if (def.show && !def.show(ctx)) return null;
  const inner = (() => {
    switch (def.type) {
      case "boolean": return <BoolRow def={def} />;
      case "number":  return <NumberRow def={def} />;
      case "text":    return <TextRow def={def} ctx={ctx} />;
      case "enum":    return <EnumRow def={def} />;
      case "action":  return <ActionRow def={def} ctx={ctx} />;
      case "custom":  return <CustomRow def={def} ctx={ctx} />;
    }
  })();
  // A widget draws its own controls, so its label is a title above it, and
  // its description introduces it rather than trailing after.
  // The wrapper draws no box (display: contents); it names the setting so a
  // search result on the phone can scroll to it.
  if (def.type === "custom") {
    return (
      <div className={def.danger ? "settings-setting settings-setting--danger" : "settings-setting"} data-setting-id={def.id}>
        {titled && def.label && <h5 className="settings-row-title">{t(def.label)}</h5>}
        {def.description && <p className="settings-hint">{t(def.description)}</p>}
        {inner}
        {def.hint && <p className="settings-hint">{t(def.hint)}</p>}
      </div>
    );
  }
  return (
    <div className="settings-setting" data-setting-id={def.id}>
      {inner}
      {def.description && <p className="settings-hint">{t(def.description)}</p>}
      {def.hint && <p className="settings-hint">{t(def.hint)}</p>}
    </div>
  );
}

/** Render a tab's worth of SettingDefs. A def with an explicit `section` gets a
 *  visible sub-heading (e.g. Export / Import / Storage & backup in Your Data);
 *  defs without one group silently by id-prefix before the first `.` (so
 *  `theme.dark` + `theme.font` group, no header — legacy behaviour). */
export function TabBody({ settings, ctx, showAdvanced }: {
  settings: SettingDef[];
  ctx: SettingContext;
  showAdvanced: boolean;
}) {
  const t = useT();
  const shown = settings.filter((s) => (showAdvanced || !isAdvanced(s, ctx)) && (!s.show || s.show(ctx)));
  // What deletes or replaces something closes its page, whatever the registry order.
  const filtered = [...shown.filter((s) => !s.danger), ...shown.filter((s) => s.danger)];
  // Group in registry order. An explicit section keys (and titles) its own
  // group; otherwise fall back to the id-prefix (untitled). The same key can
  // come back after another group (theme.* · note.* · theme.reduce_motion), so
  // React keys the section by its first setting, which is unique: a repeated
  // key left the old tab's rows on screen after switching tabs.
  const groups: { key: string; title: string | null; defs: SettingDef[] }[] = [];
  for (const s of filtered) {
    const title = s.section ?? null;
    const key = title ?? `id:${s.id.split(".")[0]}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.defs.push(s);
    else groups.push({ key, title, defs: [s] });
  }
  return (
    <>
      {groups.map(({ title, defs }) => (
        <section key={defs[0].id} className="settings-section">
          {title && <h4 className="settings-section-title">{t(title)}</h4>}
          {/* A widget's title shows unless the section heading already
              names it (a section holding only that widget). */}
          {defs.map((def) => <SettingRow key={def.id} def={def} ctx={ctx} titled={!title || defs.length > 1} />)}
        </section>
      ))}
    </>
  );
}
