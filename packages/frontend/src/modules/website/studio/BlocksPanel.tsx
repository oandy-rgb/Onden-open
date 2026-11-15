// 區塊: the kinds of block that can go on the page — what they are, never which
// note or tag (that is chosen on the right, in 屬性). Click inserts after the
// selection (or at the end of the page); dragging drops where you let go.
// Dragging only tells Puck "insert this component type": the kind's starting
// props ride along in `prefill`, which HomeStudio applies when Puck reports the
// insert (onAction), because Puck's drawer items carry no props of their own.
import { useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Drawer, Puck, type Config } from "@puckeditor/core";
import { BLOCK_TABS, blockGroups, filterGroups, useInsertBlock, type BlockTab } from "./blockKinds";
import PublishLog from "../PublishLog";
import { PREFS, usePersistedChoice } from "../../../lib/prefs";
import { Tab, TabList, SearchField } from "../../../components/ui";
import { isEnterKey } from "../../../lib/keys";
import { DRAG_SLOP_PX } from "../../../lib/pointerDrag";
import EmptyState from "../../../components/EmptyState";

/** The component the next insert should become: its type and the props the drawer item chose. */
export type Prefill = { type: string; props: Record<string, unknown> } | null;

function Entry({ id, name, label, description, icon, prefill, prefillRef, onInsert }: {
  id: string;
  name: string;
  label: string;
  /** One plain sentence under the name; also the hover text. */
  description?: string;
  icon?: ReactNode;
  prefill: Prefill;
  prefillRef: MutableRefObject<Prefill>;
  onInsert: (type: string, props: Record<string, unknown>) => void;
}) {
  const latest = useRef({ prefill, onInsert });
  latest.current = { prefill, onInsert };
  // Puck draws the item's own label and drag icon as `children`; this adds the
  // click-to-insert and the prefill on press around it.
  const shell = useMemo(() => function Shell({ children }: { children?: ReactNode }) {
    const down = useRef<{ x: number; y: number } | null>(null);
    const insert = () => latest.current.onInsert(name, latest.current.prefill?.props ?? {});
    return (
      <div
        className="hs-entry" role="button" tabIndex={0} title={description} data-described={description ? "" : undefined}
        onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; prefillRef.current = latest.current.prefill; }}
        onClick={(e) => {
          const from = down.current;
          if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP_PX) return; // a drag, not a click
          insert();
        }}
        onKeyDown={(e) => { if (isEnterKey(e) || e.key === " ") { e.preventDefault(); insert(); } }}
      >
        {icon && <span className="hs-entry__icon">{icon}</span>}
        <div className="hs-entry__main">{children}</div>
        {description && <span className="hs-entry__desc">{description}</span>}
      </div>
    );
  }, [name, prefillRef, description, icon]);
  return <Drawer.Item id={id} name={name} label={label}>{shell}</Drawer.Item>;
}

export default function BlocksPanel({ config, prefillRef, online }: { config: Config; prefillRef: MutableRefObject<Prefill>; online: boolean }) {
  const searchId = useId();
  const tabsId = useId();
  const [query, setQuery] = useState("");
  const [tab, setTab] = usePersistedChoice<BlockTab>(PREFS.siteStudioLeftTab, BLOCK_TABS.map((t) => t.id), "parts");
  const insert = useInsertBlock(config);
  const groups = useMemo(() => blockGroups(config), [config]);
  const searching = query.trim() !== "";
  // Searching looks through both tabs; each result says which tab and group it is in.
  const shown = searching ? filterGroups(groups, query) : groups.filter((g) => g.tab === tab);
  const tabLabel = (id: BlockTab) => BLOCK_TABS.find((t) => t.id === id)!.label;

  return (
    <div className="hs-assets">
      {/* The tabs sit on top like the right column's 屬性｜建議; a search looks through both, and picking a tab ends it. */}
      <TabList className="hs-tabs" label="左欄">
        {BLOCK_TABS.map(({ id, label }) => (
          <Tab
            key={id} id={`${tabsId}-tab-${id}`} selected={tab === id}
            className="hs-tab" onClick={() => { setTab(id); setQuery(""); }}
          >{label}</Tab>
        ))}
      </TabList>
      <div className="hs-panel">
      <p className="hs-hint hs-assets__lead">點一下加在選取的後面，或拖到右邊畫面。</p>
      <SearchField id={searchId} label="搜尋區塊：筆記、標籤、排版…" value={query} onValueChange={setQuery} />

      <div role={searching ? undefined : "group"} aria-labelledby={searching ? undefined : `${tabsId}-tab-${tab}`}>
        {!searching && tab === "layout" && (
          <section className="hs-section hs-structure">
            <h3 className="hs-section__title">頁面結構</h3>
            <p className="hs-hint">頁面上現有的東西，點一下就選取。</p>
            <Puck.Outline />
          </section>
        )}
        {shown.map((group) => (
          <section key={group.title} className="hs-section">
            <h3 className="hs-section__title">{group.title}{searching && <span className="hs-section__tab">・{tabLabel(group.tab)}</span>}</h3>
            <p className="hs-hint">{group.hint}</p>
            <Drawer>
              {group.kinds.map((k) => (
                <Entry
                  key={k.id} id={k.id} name={k.type} label={k.label} description={k.description} icon={k.icon}
                  prefill={k.props ? { type: k.type, props: k.props } : null} prefillRef={prefillRef} onInsert={insert}
                />
              ))}
            </Drawer>
          </section>
        ))}
        {searching && shown.length === 0 && <EmptyState size="inline" title="沒有符合的區塊。" />}
      </div>
      <PublishLog online={online} onRefresh={() => {}} />
      </div>
    </div>
  );
}
