// The toast overlay — its own store subscriber (H4) so a toast appearing or
// expiring re-renders THIS component, not the whole BuilderApp tree.

import { useEffect, useRef } from "react";

import { dismissToast, type Toast } from "../lib/appStore";
import { useToasts } from "../hooks/useToasts";
import { t } from "../lib/i18n";
import { TopLayerPortal, Pressable, layerClass, useTopModalLayer } from "./ui";

// Cap the visible stack so a burst of toasts can't grow off-screen; the store
// auto-dismisses each, so we only ever show the most recent few at once.
const MAX_VISIBLE = 4;

// On leave we don't resume the full lifetime — the user already had a chance to
// read it while hovering, so a short grace period is enough.
const RESUME_MS = 1500;

// A leading glyph per kind. Plain text glyphs (no icon dep) keep the toast
// lightweight and inherit the toast colour token.
const KIND_ICON: Record<Toast["kind"], string> = {
  success: "✓",
  error: "✕",
  warning: "⚠",
  info: "ℹ",
};

const KIND_LABEL: Record<Toast["kind"], string> = {
  success: "Success",
  error: "Error",
  warning: "Warning",
  info: "Info",
};

// One toast row. Owns its own dismiss timer so hover can pause it (the store
// only supplies the intended `duration`; duration 0 means sticky).
function ToastItem({ toast }: { toast: Toast }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const arm = (ms: number) => {
    clear();
    if (ms > 0) timerRef.current = setTimeout(() => dismissToast(toast.id), ms);
  };

  // Arm the initial lifetime once; re-arm only if the duration itself changes.
  useEffect(() => {
    arm(toast.duration);
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id, toast.duration]);

  return (
    <div
      className={`toast toast--${toast.kind}`}
      role={toast.kind === "error" ? "alert" : undefined}
      aria-busy={toast.working || undefined}
      onMouseEnter={clear}
      onMouseLeave={() => arm(RESUME_MS)}
    >
      <span className="toast-icon" aria-hidden="true">{toast.working ? "…" : KIND_ICON[toast.kind]}</span>
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <Pressable type="button" className="toast-action" onClick={toast.action.onClick}>{toast.action.label}</Pressable>
      )}
      <Pressable
        type="button"
        className="toast-dismiss"
        aria-label={t("Dismiss {kind} notification", { kind: t(KIND_LABEL[toast.kind]).toLowerCase() })}
        onClick={() => dismissToast(toast.id)}
      >
        ✕
      </Pressable>
    </div>
  );
}

// A plain 「done」 note waits while a dialog is open, so it never lands on top of what the person
// is reading or typing; it shows when the dialog closes. A failure, a warning, or a toast with
// a button (「復原」) still shows inside the dialog: it must be seen and pressable. So does the answer
// to what the person just did in that dialog (`inDialog`): waiting would leave them without feedback.
const waitsForDialog = (toast: Toast) => (toast.kind === "success" || toast.kind === "info") && !toast.action && !toast.inDialog;

export default function ToastStack() {
  const { toasts: all } = useToasts();
  const dialogOpen = useTopModalLayer() !== null;
  const toasts = dialogOpen ? all.filter((toast) => !waitsForDialog(toast)) : all;
  if (toasts.length === 0) return null;
  const visible = toasts.slice(-MAX_VISIBLE);
  // The stack is the app's primary feedback channel, so it doubles as a live
  // region: success/info are polite (role=status), errors are assertive
  // (role=alert per-toast) so a screen reader interrupts for failures.
  return (
    <TopLayerPortal>
      <div className={`${layerClass.fixed} toast-stack`} role="status" aria-live="polite" aria-atomic="false">
        {/* The kind is in the key: a notice that turns from working into an error is a new node, so assistive tech announces it. */}
        {visible.map((t) => (
          <ToastItem key={`${t.id}:${t.kind}`} toast={t} />
        ))}
      </div>
    </TopLayerPortal>
  );
}
