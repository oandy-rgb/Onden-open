import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { addToast } from "../../lib/appStore";
import { aiRoleWriter, writeErrors } from "../../lib/data";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useT } from "../../lib/i18n";
import { confirmDialog } from "../../components/ConfirmDialog";
import { Button, Menu, MenuItem, usePopover } from "../../components/ui";
import { useAiRoleInfo, useRuntimeText, type AiRoleInfo, type ReviewRule } from "./aiRoleInfo";

/** The AI a block is about: its id and name are all it uses. */
type AiRoleRef = { id: string; name: string };

/** Three facts about an AI role the owner decides by: whether its edits wait for
 *  approval, which ways of running work now (and why not), and what it used this month. */
export default function AiRoleStatus({ person, editable, online, refreshKey }: {
  person: AiRoleRef; editable: boolean; online: boolean; refreshKey: number;
}) {
  const t = useT();
  const { role, reload } = useAiRoleInfo(person.id, refreshKey);
  const text = useRuntimeText();
  if (!editable || !role) return null;
  const { input_tokens, output_tokens, cost_estimate_micro_usd } = role.usage_this_month;
  const n = (value: number) => value.toLocaleString();
  return (
    <>
      <section className="ai-role-block" aria-label={t("Review rule of {name}", { name: person.name })}>
        <h5>{t("Review rule")}</h5>
        <ReviewRuleControl person={person} role={role} online={online} onChanged={reload} />
      </section>
      <section className="ai-role-block" aria-label={t("Ways {name} can run", { name: person.name })}>
        <h5>{t("Ways to run")}</h5>
        <ul className="ai-role-list">
          {role.runtimes.map((r) => (
            <li key={r.kind}>
              <strong>{text.label(r.kind)}</strong>{r.kind === role.default_runtime && <> · {t("Used by default")}</>}
              <div className={r.available ? "member-hint" : "member-warning"}>{text.status(r)}</div>
            </li>
          ))}
        </ul>
      </section>
      <section className="ai-role-block" aria-label={t("Use this month by {name}", { name: person.name })}>
        <h5>{t("This month")}</h5>
        <p className="member-hint">
          {input_tokens === 0 && output_tokens === 0 ? t("No use this month yet.")
            : t("Input {input}, output {output} (the model's unit of text).", { input: n(input_tokens), output: n(output_tokens) })}
          {cost_estimate_micro_usd !== null && <> {t("About ${amount}. This is an estimate.", { amount: (cost_estimate_micro_usd / 1_000_000).toFixed(2) })}</>}
        </p>
      </section>
    </>
  );
}

/** 「先給我看」or 「直接改」 as a menu, like the standing of a person in a space. With the
 *  API an AI can only suggest, so the choice is shown but cannot be changed. */
function ReviewRuleControl({ person, role, online, onChanged }: {
  person: AiRoleRef; role: AiRoleInfo; online: boolean; onChanged: () => void;
}) {
  const t = useT();
  const phone = useIsMobile();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menu = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false) });
  const name = (rule: ReviewRule) => rule === "suggest" ? t("Show me first (suggest)") : t("Edit directly (undo later)");
  const shown: ReviewRule = role.review_rule_locked ? "suggest" : role.review_rule;

  async function choose(next: ReviewRule) {
    if (next === shown || busy) return;
    if (next === "apply" && !(await confirmDialog(
      t("Let {name} edit directly? Its changes go into your notes right away, without waiting for you to accept them. You can undo each one from the history.", { name: person.name }),
      { confirmLabel: t("Edit directly") }))) return;
    setBusy(true);
    try {
      await aiRoleWriter.setReviewRule(person.id, next);
      addToast(t("Saved."), "success");
      onChanged();
    } catch (error) { writeErrors.report(error, addToast); }
    finally { setBusy(false); }
  }

  const choices: Array<{ rule: ReviewRule; meaning: string }> = [
    { rule: "suggest", meaning: t("Its changes wait until you accept them") },
    { rule: "apply", meaning: t("Its changes go in at once. You can undo them from the history") },
  ];
  return (
    <>
      <Button ref={menu.anchor} variant="secondary" size="sm" aria-haspopup="menu" aria-expanded={open}
        aria-label={t("Review rule of {name}: {rule}", { name: person.name, rule: name(shown) })}
        disabled={!online || busy || role.review_rule_locked} onClick={() => setOpen(!open)}>
        {name(shown)} <ChevronDown size={13} aria-hidden="true" />
      </Button>
      {role.review_rule_locked && <p className="member-hint">{t("It runs through the API, which can only suggest. Its changes always wait for you.")}</p>}
      {open && (
        <Menu popover={menu} label={t("Review rule")} sheet={phone}>
          {choices.map(({ rule, meaning }) => (
            <MenuItem key={rule} checked={shown === rule} onSelect={() => void choose(rule)}>
              <span className="standing-menu-item"><strong>{name(rule)}</strong><small>{meaning}</small></span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}
