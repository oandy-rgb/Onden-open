// Module dialogs (any module's) are opened from plain handlers (a sidebar "+" entry, a note
// command), so they mount their own root like confirmDialog does: one dialog
// at a time, removed when it closes.
import { Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

let current: { root: Root; host: HTMLElement } | null = null;

export function closeModuleDialog(): void {
  if (!current) return;
  const { root, host } = current;
  current = null;
  root.unmount();
  host.remove();
}

export function openModuleDialog(render: (close: () => void) => ReactNode): void {
  closeModuleDialog();
  const host = document.createElement("div");
  host.className = "module-dialog-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  current = { root, host };
  // A dialog may be a lazy component (a module loads its dialogs on the click).
  root.render(<Suspense fallback={null}>{render(closeModuleDialog)}</Suspense>);
}
