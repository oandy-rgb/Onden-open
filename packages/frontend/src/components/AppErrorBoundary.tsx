import { reloadPage } from "../lib/api";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../lib/i18n";
import { reportRenderError } from "../lib/reportRenderError";
import { browserOffline, isChunkLoadError } from "../lib/lazyWithReload";
import "./AppErrorBoundary.css";
import { Button, layerClass } from "./ui";

// Last-resort catch for the whole React tree. Before this existed, any render
// error white-screened the app with nothing but the console to go on. The
// fallback deliberately avoids app state/providers (they may be the thing
// that crashed): plain markup, theme tokens, a hard reload.
//
// Error boundaries must be class components — React has no hook equivalent
// for getDerivedStateFromError/componentDidCatch.

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRenderError("AppErrorBoundary", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    // A code-split file this tab asked for did not load. Online, Onden was
    // updated since the page loaded (lib/lazyWithReload.ts already tried one
    // reload); offline, this device never fetched that part (lib/offlineWarmup.ts).
    const chunk = isChunkLoadError(this.state.error);
    const offline = chunk && browserOffline();
    const [title, body] = offline
      ? [t("Not available offline yet"), t("This part of Onden is not on this device yet. Reconnect, then reload. Your notes are safe.")]
      : chunk
        ? [t("Onden was updated"), t("This page is running an older version of Onden. Reload to load the new one. Your notes are safe.")]
        : [t("Something went wrong"), t("The app hit an unexpected error. Your notes are safe — changes are persisted as you work. Reloading usually fixes it.")];
    return (
      <div className={`${layerClass.fill} app-error-boundary`} role="alert">
        <h1>{title}</h1>
        <p>{body}</p>
        <Button type="button" onClick={() => reloadPage()}>
          {t("Reload")}
        </Button>
      </div>
    );
  }
}
