import { useT } from "../lib/i18n";
import { handFailureText, waitingCard } from "../lib/handToAi";
import type { HandToAi } from "../hooks/useHandToAi";
import { Button, Popover, usePopover } from "./ui";
import "./HandToAiMenu.css";

// The card for the one request in flight. With the API way of running the answer
// is written into it as it comes (a preview only: when it ends it becomes ONE
// pending suggestion in the note, which the suggestion bar shows in place with
// accept / reject). The other ways don't stream, so it says what the @ai card
// says: sent, received, working. A request can be cancelled while it works; a
// cancelled one leaves no suggestion.
export default function HandToAiPreview({ hand }: { hand: HandToAi }) {
  const t = useT();
  const run = hand.run;
  const popover = usePopover<HTMLElement>({ open: run !== null, onClose: () => { if (run && run.phase !== "starting" && run.phase !== "streaming" && run.phase !== "waiting") hand.dismiss(); }, at: run?.at });
  if (!run) return null;
  const open = run.phase === "starting" || run.phase === "streaming" || run.phase === "waiting";
  const waiting = run.phase === "waiting" ? waitingCard(run, Date.now()) : null;
  const status =
    run.phase === "starting" ? t("Sending…")
    : run.phase === "streaming" ? (run.text ? t("Writing…") : t("The AI is working…"))
    : run.phase === "waiting" ? (waiting?.text ?? t("The AI is working…"))
    : run.phase === "done" ? t("Done. The change is in the note as a suggestion to accept or reject.")
    : run.phase === "cancelled" ? t("Cancelled. Nothing was suggested.")
    : handFailureText(run.failCode);
  return (
    <Popover popover={popover} label={t("Hand to AI")} role="dialog">
      <div className="hand-ai-card">
        <div className="hand-ai-card-head"><span>{run.skillName}</span><span>{run.line}</span></div>
        {run.runtime === "api" && run.text && <pre className="hand-ai-card-text" aria-live="polite">{run.text}</pre>}
        <p className="hand-ai-card-status" data-tone={run.phase === "failed" ? "failed" : undefined} role="status">{status}</p>
        <div className="hand-ai-card-buttons">
          {open && <Button size="sm" variant="secondary" onClick={() => void hand.cancel()}>{t("Cancel")}</Button>}
          {(run.phase === "failed" || run.phase === "cancelled") && <Button size="sm" variant="secondary" onClick={hand.retry}>{t("Try again")}</Button>}
          {!open && <Button size="sm" variant="primary" onClick={hand.dismiss}>{t("Close")}</Button>}
        </div>
      </div>
    </Popover>
  );
}
