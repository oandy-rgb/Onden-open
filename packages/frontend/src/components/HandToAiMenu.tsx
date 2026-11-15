import { useState } from "react";
import { Check, MoreHorizontal, Sparkles } from "lucide-react";
import { useT } from "../lib/i18n";
import { isEnterKey } from "../lib/keys";
import { runtimeName, targetLine, waysOf, type HandRole, type HandRuntime } from "../lib/handToAi";
import type { HandToAi } from "../hooks/useHandToAi";
import { Button, Menu, MenuHeading, MenuItem, MenuSeparator, TextField, type PopoverState } from "./ui";
import "./HandToAiMenu.css";

// What the 「AI」 button of the selection bar, and the 「AI」 row of the 「這段」 menu,
// open: the ready-made actions, then 「自訂…」 (one of the person's skills, or one
// sentence for this once). The small line under the heading says which AI role and
// which way of running the request goes to; 「⋯」 changes that for this once.

type View = "actions" | "target" | "custom";

export default function HandToAiMenu({ popover, hand, text, at, label }: {
  popover: PopoverState<HTMLElement>;
  hand: HandToAi;
  /** Exactly what the AI works on and its answer replaces: the selection, or the paragraph. */
  text: string;
  /** Where the preview card appears (a viewport point near the text). */
  at: { x: number; y: number };
  /** Accessible name: what is handed over ("Selected text" / "This paragraph"). */
  label: string;
}) {
  const t = useT();
  const [view, setView] = useState<View>("actions");
  const [skillId, setSkillId] = useState<string | null>(null);
  const [sentence, setSentence] = useState("");
  const { entry, target, actions, noteSkills } = hand;
  const go = (skill: string, skillName: string, instruction?: string) => { void hand.start({ skill, skillName, text, instruction, at }); };

  if (entry.blocked) {
    return (
      <Menu popover={popover} label={label}>
        <MenuHeading>{t("Hand to AI")}</MenuHeading>
        <p className="hand-ai-note" role="note">{entry.blocked}</p>
      </Menu>
    );
  }

  if (view === "target") {
    return (
      <Menu popover={popover} label={t("Who runs this")}>
        <MenuHeading>{t("Who runs this")}</MenuHeading>
        {hand.roles.map((role: HandRole) => (
          <div key={role.actor_id} role="group" aria-label={role.name}>
            <p className="hand-ai-role">{role.name}</p>
            {waysOf(role).map((kind: HandRuntime) => (
              <MenuItem key={kind} keepOpen checked={target?.role.actor_id === role.actor_id && target.runtime === kind}
                onSelect={() => { hand.setPick({ roleId: role.actor_id, runtime: kind }); setView("actions"); }}>
                {runtimeName(kind)}
                {kind === role.default_runtime && <span className="hand-ai-hint">{t("usual")}</span>}
              </MenuItem>
            ))}
          </div>
        ))}
        <MenuSeparator />
        <p className="hand-ai-note" role="note">{t("Only for this once.")}</p>
        <MenuItem keepOpen onSelect={() => setView("actions")}>{t("Back")}</MenuItem>
      </Menu>
    );
  }

  if (view === "custom") {
    const chosen = noteSkills.find((skill) => skill.id === skillId) ?? null;
    const trimmed = sentence.trim();
    const ready = chosen !== null || trimmed.length > 0;
    return (
      <Menu popover={popover} label={t("Custom")}>
        <MenuHeading>{t("Custom")}</MenuHeading>
        {noteSkills.length > 0 && (
          <div role="group" aria-label={t("Your skills")}>
            {noteSkills.map((skill) => (
              <MenuItem key={skill.id} keepOpen checked={skillId === skill.id} onSelect={() => setSkillId(skillId === skill.id ? null : skill.id)}>
                {skill.name}
              </MenuItem>
            ))}
          </div>
        )}
        <div className="hand-ai-custom">
          <TextField value={sentence} maxLength={500} placeholder={t("Or say what to do, just this once")} aria-label={t("What to do with this text")}
            onChange={(e) => setSentence(e.target.value)}
            onKeyDown={(e) => { if (isEnterKey(e) && ready) { e.preventDefault(); go(chosen?.id ?? "rewrite", chosen?.name ?? t("Custom"), trimmed || undefined); popover.close(); } }} />
          <p className="hand-ai-note">{t("The sentence is used once and isn't saved.")}</p>
          <div className="hand-ai-buttons">
            <Button size="sm" variant="ghost" onClick={() => setView("actions")}>{t("Back")}</Button>
            <Button size="sm" variant="primary" disabled={!ready}
              onClick={() => { go(chosen?.id ?? "rewrite", chosen?.name ?? t("Custom"), trimmed || undefined); popover.close(); }}>{t("Send")}</Button>
          </div>
        </div>
      </Menu>
    );
  }

  return (
    <Menu popover={popover} label={label}>
      <MenuHeading>{t("Hand to AI")}</MenuHeading>
      <div className="hand-ai-target">
        <span className="hand-ai-line">{target ? targetLine(target) : t("Looking for an AI…")}</span>
        <Button variant="icon" size="sm" aria-label={t("Change who runs this")} title={t("Change who runs this")}
          disabled={hand.roles.length === 0} onClick={() => setView("target")}><MoreHorizontal size={14} aria-hidden="true" /></Button>
      </div>
      {actions.map((action) => (
        <MenuItem key={action.id} onSelect={() => go(action.id, t(action.label))}><Sparkles size={16} aria-hidden="true" />{t(action.label)}</MenuItem>
      ))}
      <MenuItem keepOpen onSelect={() => setView("custom")}><Check size={16} aria-hidden="true" />{t("Custom…")}</MenuItem>
    </Menu>
  );
}
