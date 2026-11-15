import { useEffect, useRef, type ReactNode } from "react";
import { parseSteps } from "@onden/markdown";
import "./StepsFigure.css";

/** The words of the player's bar, in the reader's language (the app's `t`, the site's locale). */
export type StepsLabels = { prev: string; next: string; expand: string; collapse: string; count: string };

export type StepsFigureProps = {
  /** The text of the ```steps block. */
  source: string;
  /** A step's Markdown drawn like the rest of the page (MarkdownRenderer). */
  renderBody: (markdown: string) => ReactNode;
  labels: StepsLabels;
};

/** A ```steps block drawn as a plain list of its steps — what a reader without
 *  script sees, and the markup the player works over (stepsEnhance.ts has the
 *  contract). In the browser the player is wired once this is on the page (a
 *  separate chunk, loaded only for a note that has the block); the published
 *  site runs no React, so its own script does the same over the server-drawn
 *  markup. */
export default function StepsFigure({ source, renderBody, labels }: StepsFigureProps) {
  const root = useRef<HTMLDivElement>(null);
  const { intro, steps } = parseSteps(source);

  useEffect(() => {
    const figure = root.current;
    if (!figure || steps.length === 0) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@onden/markdown/steps-enhance").then((m) => { if (!cancelled) stop = m.installStepsPlayer(figure); });
    return () => { cancelled = true; stop?.(); };
  }, [source, steps.length]);

  return (
    <div
      ref={root}
      className="md-steps"
      {...(steps.length > 0 && {
        "data-steps": "", "data-l-prev": labels.prev, "data-l-next": labels.next,
        "data-l-expand": labels.expand, "data-l-collapse": labels.collapse, "data-l-count": labels.count,
      })}
    >
      {intro && <div className="md-steps-intro">{renderBody(intro)}</div>}
      {steps.length > 0 && (
        <div className="md-steps-stage">
          {steps.map((step, i) => (
            <section key={i} className="md-step" data-step-title={step.title || undefined}>
              {step.title && <h3 className="md-step-title">{step.title}</h3>}
              <div className="md-step-body">{renderBody(step.body)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
