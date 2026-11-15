import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { useT } from "../lib/i18n";
import { isImeComposing } from "../lib/keys";
import {
  isDefaultToolbar, moveTool, placeTool, resetToolbar, resolveToolbar, setToolShown, toolLabel, TOUCH_LABELED_LIMIT,
  type ToolbarSurface,
} from "../lib/toolbarLayout";
import { useToolbarLayout } from "../lib/toolbarLayoutStore";
import { classNames } from "../lib/utils";
import { Button, Switch, Pressable } from "./ui";
import { useDragReorder } from "./NavLayoutEditor";
import { TOOL_ICONS } from "./toolbarIcons";
import "./NavLayoutEditor.css";

// Settings › 工具列: for each toolbar, which buttons it shows and in what order
// (lib/toolbarLayout). The same rows and gestures as Settings › 導覽列: a
// switch per button, a handle to drag (or arrow keys, or 上移 / 下移), and
// 「恢復預設」. A button turned off is not gone: it waits in 「更多」. Every
// change is saved at once, to the account.

const SURFACES: Array<{ surface: ToolbarSurface; title: string; hint: string }> = [
  {
    surface: "bar",
    title: "Phone and tablet format bar",
    hint: "The bar above the keyboard while you write. The first {n} buttons with words are shown; the others wait in More.",
  },
  {
    surface: "selection",
    title: "Selection toolbar",
    hint: "Appears over selected text, on every device. Buttons turned off stay in More.",
  },
];

function ToolbarSurfaceEditor({ surface, title, hint }: { surface: ToolbarSurface; title: string; hint: string }) {
  const t = useT();
  const { value: stored, save } = useToolbarLayout();
  const { shown, more } = resolveToolbar(stored, surface);
  const [selected, setSelected] = useState<string | null>(null);
  const change = (next: ReturnType<typeof setToolShown>) => { if (next !== stored) save(next); };
  const { drag, handle } = useDragReorder(
    (id, index) => change(placeTool(stored, surface, id, index)),
    (id) => setSelected((current) => (current === id ? null : id)),
  );
  const keys = (id: string) => (event: KeyboardEvent) => {
    if (isImeComposing(event)) return;
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    change(moveTool(stored, surface, id, delta));
  };
  const last = shown.length - 1;
  return (
    <section className="toolbar-editor" data-testid={`toolbar-${surface}`}>
      <h4 className="nav-settings-heading">{t(title)}</h4>
      <p className="nav-editor-hint">{t(hint, { n: TOUCH_LABELED_LIMIT })}</p>
      <ul className="nav-reorder-list" aria-label={t(title)}>
        {shown.map((tool, index) => {
          const Icon = TOOL_ICONS[tool.id]!;
          const name = t(toolLabel(tool));
          return (
            <li key={tool.id} data-reorder-index={index} data-tool={tool.id}
              className={classNames("nav-reorder-row", drag?.id === tool.id && "is-dragging", drag && drag.over === index && drag.id !== tool.id && "is-drop-target")}>
              <Pressable type="button" className="nav-reorder-handle" aria-label={t("Reorder “{name}”", { name })} aria-expanded={selected === tool.id}
                title={t("Drag, or use the arrow keys")} {...handle(tool.id, index)} onKeyDown={keys(tool.id)}>
                <GripVertical size={16} aria-hidden="true" />
              </Pressable>
              <Icon size={18} aria-hidden="true" className="nav-reorder-icon" />
              <span className="nav-reorder-label">{name}</span>
              {tool.onden && <span className="nav-reorder-note">{t("With words")}</span>}
              <span className="nav-reorder-actions">
                {selected === tool.id && <>
                  <Button variant="icon" size="sm" aria-label={t("Move “{name}” up", { name })}
                    disabled={index === 0} onClick={() => change(moveTool(stored, surface, tool.id, -1))}><ArrowUp size={14} /></Button>
                  <Button variant="icon" size="sm" aria-label={t("Move “{name}” down", { name })}
                    disabled={index === last} onClick={() => change(moveTool(stored, surface, tool.id, 1))}><ArrowDown size={14} /></Button>
                </>}
                <Switch on label={t("Show “{name}” in the toolbar", { name })} onChange={() => change(setToolShown(stored, surface, tool.id, false))} />
              </span>
            </li>
          );
        })}
        {drag && <li className={classNames("nav-reorder-end", drag.over === shown.length && "is-drop-target")} data-reorder-index={shown.length} aria-hidden="true" />}
      </ul>
      {more.length > 0 && <>
        <h5 className="toolbar-more-heading">{t("In More")}</h5>
        <ul className="nav-reorder-list" aria-label={t("In More")}>
          {more.map((tool) => {
            const Icon = TOOL_ICONS[tool.id]!;
            const name = t(toolLabel(tool));
            return (
              <li key={tool.id} className="nav-reorder-row" data-tool={tool.id}>
                <span className="nav-reorder-handle" aria-hidden="true" />
                <Icon size={18} aria-hidden="true" className="nav-reorder-icon" />
                <span className="nav-reorder-label">{name}</span>
                {tool.onden && <span className="nav-reorder-note">{t("With words")}</span>}
                <span className="nav-reorder-actions">
                  <Switch on={false} label={t("Show “{name}” in the toolbar", { name })} onChange={() => change(setToolShown(stored, surface, tool.id, true))} />
                </span>
              </li>
            );
          })}
        </ul>
      </>}
      <div className="nav-editor-actions">
        <Button disabled={isDefaultToolbar(stored, surface)} onClick={() => change(resetToolbar(stored, surface))}>{t("Reset")}</Button>
      </div>
    </section>
  );
}

/** Both toolbars' layouts, one editor each. */
export function ToolbarLayoutEditor() {
  const t = useT();
  return (
    <div className="nav-editor toolbar-editors" data-testid="toolbar-settings">
      <p className="nav-editor-hint">{t("Follows your account. A button turned off is not lost: find it in More.")}</p>
      {SURFACES.map((spec) => <ToolbarSurfaceEditor key={spec.surface} {...spec} />)}
    </div>
  );
}
