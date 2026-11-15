import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../lib/i18n";
import { reportRenderError } from "../lib/reportRenderError";
import { isChunkLoadError } from "../lib/lazyWithReload";
import { Button } from "./ui";
import "./RegionErrorBoundary.css";

// A render error in one region (the sidebar, the info panel, the main area, one module screen, one view tab)
// shows a small message in that region only; the rest of the app stays. AppErrorBoundary remains the last resort.
//
// It never unmounts healthy children: nothing remounts unless a child threw, so an editor beside a broken region
// keeps what is being typed. `resetKeys` clears the error when the user goes somewhere else (another note, page
// or tab) so they are not stuck on the message; they are compared by value, not used as a React `key`.
//
// A code-split file that did not load is not this region's to answer: rendering again cannot fetch it (a lazy component
// keeps the failure). It goes on to AppErrorBoundary, which says "Onden was updated" or "not on this device yet"
// and offers the reload that fixes it.

type Props = {
  children: ReactNode;
  /** Which region this is, for the console report only (never shown). */
  region: string;
  /** When any of these change, the error is cleared and the children render again. */
  resetKeys?: ReadonlyArray<unknown>;
};
type State = { error: Error | null };

const keysChanged = (a: ReadonlyArray<unknown> = [], b: ReadonlyArray<unknown> = []) =>
  a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));

export default class RegionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRenderError(`RegionErrorBoundary:${this.props.region}`, error, info);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (isChunkLoadError(this.state.error)) throw this.state.error;
    return (
      <div className="region-error-boundary" role="alert">
        <p>{t("This part can't be shown right now. The rest of Onden still works, and your notes are safe.")}</p>
        <Button type="button" size="sm" onClick={() => this.setState({ error: null })}>
          {t("Try this part again")}
        </Button>
      </div>
    );
  }
}
