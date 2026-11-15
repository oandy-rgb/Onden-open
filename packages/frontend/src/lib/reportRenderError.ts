import type { ErrorInfo } from "react";

/** Where a React render error is recorded: the console, with the component stack. Both the last-resort
 *  AppErrorBoundary and RegionErrorBoundary use it, so an error is reported the same way wherever it is caught. */
export function reportRenderError(boundary: string, error: Error, info: ErrorInfo) {
  console.error(`[${boundary}]`, error, info.componentStack);
}
