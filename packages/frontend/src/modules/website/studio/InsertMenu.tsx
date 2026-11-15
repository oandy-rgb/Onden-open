// Adding a block from the canvas: a ＋ that stays beside the selected block
// (not a hover-only control), and `/` anywhere on the page, both open the same
// menu of block kinds. Choosing one inserts it after the selection.
import { useEffect, useId, useLayoutEffect, useMemo, useState, type CSSProperties, type RefObject } from "react";
import { createUsePuck, type Config } from "@puckeditor/core";
import { Popover, Pressable, usePopover, SearchField, type PopoverState } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { blockGroups, filterGroups, useInsertBlock, type BlockKind } from "./blockKinds";
import { observeSize } from "../../../lib/observeSize";
import EmptyState from "../../../components/EmptyState";
import { onWindow } from "../../../lib/globalEvents";

const usePuck = createUsePuck();

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest("[role='dialog']") !== null);
};

function Menu({ config, popover, onPick, where }: { config: Config; popover: PopoverState<HTMLElement>; onPick: (kind: BlockKind) => void; where: string }) {
  const t = useT();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => blockGroups(config), [config]);
  const shown = filterGroups(groups, query);
  const first = shown[0]?.kinds[0];
  return (
    <Popover popover={popover} label={t("Add a block")} className="hs-insert-menu">
      <label className="hs-insert-menu__label" htmlFor={inputId}>{where}</label>
      <SearchField
        id={inputId} label={t("Search blocks…")} value={query} autoFocus
        onValueChange={setQuery}
        onEnter={() => { if (first) onPick(first); }}
      />
      <div className="hs-insert-menu__list">
        {shown.map((group) => (
          <section key={group.title}>
            <h4 className="hs-insert-menu__group">{group.title}</h4>
            {group.kinds.map((kind) => (
              <Pressable key={kind.id} type="button" className="hs-insert-item" onClick={() => onPick(kind)}>
                <span className="hs-entry__icon">{kind.icon}</span>
                <span className="hs-insert-item__name">{kind.label}</span>
                <span className="hs-insert-item__desc">{kind.description}</span>
              </Pressable>
            ))}
          </section>
        ))}
        {shown.length === 0 && <EmptyState size="inline" title={t("No matching blocks.")} />}
      </div>
    </Popover>
  );
}

/** Rendered inside the canvas frame (`position: relative`); `frameRef` is that frame. */
export default function InsertMenu({ config, frameRef }: { config: Config; frameRef: RefObject<HTMLElement | null> }) {
  const selectedId = usePuck((s) => (s.selectedItem?.props.id as string | undefined) ?? null);
  const content = usePuck((s) => s.appState.data.content);
  const t = useT();
  const insert = useInsertBlock(config);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // Where the selected block is, in the frame's own coordinates; the ＋ sits on its lower edge.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const el = selectedId && frame ? frame.querySelector<HTMLElement>(`[data-node="${selectedId.replace(/["\\]/g, "\\$&")}"]`) : null;
    if (!frame || !el) { setAt(null); return; }
    const place = () => {
      const f = frame.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      setAt({ top: r.bottom - f.top, left: r.left - f.left + r.width / 2 });
    };
    place();
    return observeSize([el, frame], place);
  }, [selectedId, content, frameRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    return onWindow("keydown", onKey);
  }, []);

  // Non-modal: the page behind stays usable; Esc and a press outside close it (usePopover).
  const popover = usePopover<HTMLDivElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  const where = selectedId ? t("Add after the selected block") : t("Add at the end of the page");
  const menu = open && (
    <Menu config={config} where={where} popover={popover} onPick={(kind) => { insert(kind.type, kind.props ?? {}); setOpen(false); }} />
  );
  if (!selectedId || !at) {
    // Nothing selected (or not drawn): only the `/` menu, over the top of the page.
    return open ? <div ref={popover.anchor} className="hs-insert hs-insert--page">{menu}</div> : null;
  }
  return (
    <div ref={popover.anchor} className="hs-insert" style={{ "--at-top": `${at.top}px`, "--at-left": `${at.left}px` } as CSSProperties}>
      <Pressable
        type="button" className="hs-insert__plus" aria-label={t("Add a block after this one")} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >＋</Pressable>
      {menu}
    </div>
  );
}
