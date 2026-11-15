import { useState, type MouseEvent, type ReactNode } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { useT } from "../lib/i18n";
import { toolbarRows, toolLabel, type ToolDef, type ToolbarSurface } from "../lib/toolbarLayout";
import { useToolbarLayout } from "../lib/toolbarLayoutStore";
import { Menu, MenuItem, MenuSeparator, keepFocus, usePopover, Pressable } from "./ui";
import { openToolbarEditor } from "../lib/toolbarEditorRequest";
import { TOOL_ICONS } from "./toolbarIcons";

// The buttons of one editor toolbar, drawn from the person's layout
// (lib/toolbarLayout, Settings › 工具列): the buttons they chose, in their
// order, then 「更多」 holding the rest. The caller says what each button does
// (`tools`, by id) and leaves out the ones that don't apply now; this decides
// which are drawn, how, and what waits in 「更多」.
//
//   variant "bar"     the phone and tablet bar: 44px buttons that act on click
//                     (a swipe scrolls the row instead) and keep editor focus
//                     by preventDefault on pointerdown;
//   variant "bubble"  the floating bubble: small buttons that act on mousedown
//                     with preventDefault so the selection survives.
//
// A general format is an icon (its name is the tooltip); an Onden action is the
// icon and its words.

/** What one button does (its icon is toolbarIcons'). */
export type ToolSpec = {
  /** `anchor`: the element pressed — or 「更多」, when the button waits there —
   *  for a button that opens a panel next to itself. */
  run: (anchor: HTMLElement | null) => void;
  /** Shown as pressed (the selection already has this format). */
  pressed?: boolean;
  /** Can't run now; a string is the reason, shown as the tooltip. */
  disabled?: boolean | string;
  /** Opens a panel (a picker): acts on click, also in the bubble. */
  opensPanel?: boolean;
};

export type ToolSpecs = Partial<Record<string, ToolSpec>>;

type Props = {
  surface: ToolbarSurface;
  variant: "bar" | "bubble";
  tools: ToolSpecs;
  /** 「更多」 is open: the editor keeps its bar up while focus is in it. */
  onMoreOpenChange?: (open: boolean) => void;
};

export default function ToolbarRow({ surface, variant, tools, onMoreOpenChange }: Props) {
  const t = useT();
  const layout = useToolbarLayout().value;
  const bar = variant === "bar";
  const available = new Set(Object.keys(tools).filter((id) => tools[id]));
  const { shown, more } = toolbarRows(layout, surface, available, bar);
  const [moreOpen, setMoreOpen] = useState(false);
  const morePop = usePopover<HTMLButtonElement>({
    open: moreOpen, onClose: () => { setMoreOpen(false); onMoreOpenChange?.(false); }, placement: bar ? "top-end" : "bottom-end",
  });
  const iconSize = bar ? 18 : 13;

  const button = (key: string, label: string, Icon: LucideIcon, labeled: boolean, spec: Pick<ToolSpec, "pressed" | "disabled" | "opensPanel">, run: (anchor: HTMLElement | null) => void) => {
    const reason = typeof spec.disabled === "string" ? spec.disabled : undefined;
    const onClick = (event: MouseEvent<HTMLButtonElement>) => run(event.currentTarget);
    return (
      <Pressable key={key} type="button" title={reason ?? label} aria-label={label} disabled={!!spec.disabled} aria-disabled={spec.disabled ? true : undefined}
        data-tool={key}
        {...(spec.pressed === undefined ? {} : { "aria-pressed": spec.pressed })}
        className={bar ? `md-mobile-tool${labeled ? " md-mobile-tool--labeled" : ""}` : labeled ? "tiptap-bubble-labeled" : undefined}
        {...(bar
          ? { onMouseDown: keepFocus, onClick }
          : spec.opensPanel ? { onClick } : { onMouseDown: (event: MouseEvent<HTMLButtonElement>) => { keepFocus(event); run(event.currentTarget); } })}>
        <Icon size={iconSize} aria-hidden="true" />
        {labeled && <span className="tool-label">{label}</span>}
      </Pressable>
    );
  };

  const draw = (def: ToolDef): ReactNode => {
    const spec = tools[def.id];
    if (!spec) return null;
    return button(def.id, t(toolLabel(def)), TOOL_ICONS[def.id]!, def.onden, spec, spec.run);
  };

  const row = shown.map(draw);
  const moreButton = more.length > 0 && (
    <Pressable type="button" ref={morePop.anchor} data-tool="more" className={bar ? "md-mobile-tool md-mobile-tool--more" : undefined}
      title={t("More")} aria-label={t("More")} aria-haspopup="menu" aria-expanded={moreOpen}
      {...(bar
        ? { onMouseDown: keepFocus }
        : { onMouseDown: keepFocus })}
      onClick={() => { setMoreOpen(!moreOpen); onMoreOpenChange?.(!moreOpen); }}>
      <MoreHorizontal size={iconSize} aria-hidden="true" />
    </Pressable>
  );
  const moreMenu = moreOpen && (
    <Menu popover={morePop} label={t("More")}>
      {more.map((def) => {
        const spec = tools[def.id];
        if (!spec) return null;
        const Icon = TOOL_ICONS[def.id]!;
        return (
          <MenuItem key={def.id} disabled={!!spec.disabled} onSelect={() => spec.run(morePop.anchor.current)}>
            <Icon size={16} />{t(toolLabel(def))}
            {typeof spec.disabled === "string" && <span className="paragraph-menu-hint">{spec.disabled}</span>}
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem onSelect={openToolbarEditor}>{t("Edit the toolbar…")}</MenuItem>
    </Menu>
  );

  if (bar) return <><div className="md-mobile-toolbar-scroll">{row}</div>{moreButton}{moreMenu}</>;
  return <>{row}{moreButton}{moreMenu}</>;
}
