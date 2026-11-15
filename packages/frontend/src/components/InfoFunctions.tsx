import { Suspense, useState } from "react";
import { ChevronRight, Minus, Plus } from "lucide-react";
import { useT } from "../lib/i18n";
import type { ContentNode } from "../lib/api";
import type { NoteFunctionRow } from "../modules";
import { classNames } from "../lib/utils";
import "./InfoFunctions.css";
import "./infoFunctions";
import { Button, Chip, Pressable } from "./ui";

/** A row shows at most this many of its details (a module gives them all, newest or nearest first). */
const DETAILS_SHOWN = 3;

// The info panel's 「功能」 tab: how this note ties into Onden's other features.
// Upper list: one card per feature the note already has a tie to — icon, the
// feature's name, a sentence, a number when something waits; open it for up to
// three details, one button and a jump to where the feature shows the note.
// Under it one line 「還能用在這則」: features that can be used here but have no tie
// yet. The rows come from hooks/useNoteFunctions; this file knows no feature.

type Props = { node: ContentNode; rows: readonly NoteFunctionRow[] };

function Card({ row, open, onToggle }: { row: NoteFunctionRow; open: boolean; onToggle: () => void }) {
  const t = useT();
  const { Icon } = row;
  return (
    <div className={classNames("info-fn-card", open && "is-open")}>
      <Pressable type="button" className="info-fn-head tap-target" aria-expanded={open} onClick={onToggle}>
        <span className="info-fn-icon" aria-hidden="true"><Icon size={16} /></span>
        <span className="info-fn-text">
          <span className="info-fn-name">{row.name}</span>
          <span className="info-fn-status">{row.status}</span>
        </span>
        {row.badge && <Chip tone={row.badge.alert ? "accent" : "neutral"} className="info-fn-count" aria-label={t("{n} waiting", { n: row.badge.n })}>{row.badge.n}</Chip>}
        <ChevronRight size={16} aria-hidden="true" className="info-fn-chevron" />
      </Pressable>
      {open && (
        <div className="info-fn-body">
          {row.details?.filter((_, index) => index < DETAILS_SHOWN).map((line) => <p key={line} className="info-fn-detail">{line}</p>)}
          <div className="info-fn-actions">
            {row.action && <Button size="sm" variant="primary" onClick={() => void row.action!.run()}>{row.action.label}</Button>}
            {row.jump && <Button size="sm" onClick={row.jump.run}>{row.jump.label} →</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function InfoFunctions({ node, rows }: Props) {
  const t = useT();
  const [openId, setOpenId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const related = rows.filter((row) => row.related);
  const more = rows.filter((row) => !row.related && !row.Custom);
  if (related.length === 0 && more.length === 0) return <p className="info-panel-quiet">{t("Nothing here ties to this note yet.")}</p>;
  return (
    <section className="info-fn" aria-label={t("Functions")}>
      {related.length > 0 && (
        <>
          <h3 className="info-fn-title">{t("Features tied to this note")}</h3>
          <ul className="info-fn-list">
            {related.map((row) => (
              <li key={row.id}>
                {row.Custom
                  ? <div className="info-function-row"><Suspense fallback={null}><row.Custom node={node} readOnly={false} /></Suspense></div>
                  : <Card row={row} open={openId === row.id} onToggle={() => setOpenId(openId === row.id ? null : row.id)} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {more.length > 0 && (
        <>
          <Pressable type="button" className="info-fn-more tap-target" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            <span className="info-fn-more-text">{t("Also usable here: {names}", { names: more.map((row) => row.name).join(", ") })}</span>
            {moreOpen ? <Minus size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          </Pressable>
          {moreOpen && (
            <ul className="info-fn-list">
              {more.map((row) => (
                <li key={row.id} className="info-fn-idle">
                  <span className="info-fn-text">
                    <span className="info-fn-idle-name">{row.name}</span>
                    <span className="info-fn-status">{row.status}</span>
                  </span>
                  {row.action && <Button size="sm" onClick={() => void row.action!.run()}>{row.action.label}</Button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
