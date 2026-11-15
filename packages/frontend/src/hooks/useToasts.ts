// Toast state lives in the app store (H4) so addToast is a stable module
// function — mutations in lib/data/, hooks, and components import it directly
// instead of threading an onError/addToast prop through BuilderApp.

import { addToast, useAppSelector, type Toast, type ToastAction } from "../lib/appStore";

export type { Toast, ToastAction };

export function useToasts() {
  const toasts = useAppSelector((s) => s.toasts);
  return { toasts, addToast };
}
