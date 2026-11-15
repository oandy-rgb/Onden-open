// What a running api selection action shows while it runs, kept in this process only:
//   preview   the text so far, for the floating preview card (routes/aiRuntime.ts, SSE).
//   step      what the AI is doing now (an info-panel turn reads and searches before it answers).
//             Nothing here is saved; the suggestion is made from the finished text.
//   abort     cancel() stops the model call instead of letting it run on and bill.
// A restart loses both, which is harmless: the sweep ends the session as interrupted.
import { cutToUnits } from "@onden/markdown";

const PREVIEW_MAX = 40_000;
const KEEP_AFTER_END_MS = 60_000;

/** `step`: what the AI is doing now, in words for the person (「正在讀〈某筆記〉」). Never saved. */
export type LiveEvent = { kind: "text"; text: string } | { kind: "restart" } | { kind: "step"; step: LiveStep } | { kind: "end" };
export type LiveStep = { what: "read" | "search" | "write"; title: string | null };
type Listener = (event: LiveEvent) => void;
type Live = { text: string; step: LiveStep | null; ended: boolean; listeners: Set<Listener>; abort: AbortController };
const runs = new Map<string, Live>();

/** A run is starting: the controller its model call must listen to. */
export function beginLive(sessionId: string): AbortController {
  const live: Live = { text: "", step: null, ended: false, listeners: new Set(), abort: new AbortController() };
  runs.set(sessionId, live);
  return live.abort;
}
export function pushPreview(sessionId: string, delta: string): void {
  const live = runs.get(sessionId);
  if (!live || live.ended) return;
  live.text = cutToUnits(live.text + delta, PREVIEW_MAX);
  for (const listener of live.listeners) listener({ kind: "text", text: delta });
}
/** A tool-using turn ended and the AI goes on: what was streamed so far was not the answer. */
export function restartPreview(sessionId: string): void {
  const live = runs.get(sessionId);
  if (!live || live.ended || live.text === "") return;
  live.text = "";
  for (const listener of live.listeners) listener({ kind: "restart" });
}
export function pushStep(sessionId: string, step: LiveStep): void {
  const live = runs.get(sessionId);
  if (!live || live.ended) return;
  live.step = step;
  for (const listener of live.listeners) listener({ kind: "step", step });
}
export function endLive(sessionId: string): void {
  const live = runs.get(sessionId);
  if (!live || live.ended) return;
  live.ended = true;
  for (const listener of live.listeners) listener({ kind: "end" });
  setTimeout(() => runs.delete(sessionId), KEEP_AFTER_END_MS).unref?.();
}
/** The text so far and a way to follow it. Null when this process is not running (or did not run) it. */
export function followPreview(sessionId: string, listener: Listener): { text: string; step: LiveStep | null; ended: boolean; stop: () => void } | null {
  const live = runs.get(sessionId);
  if (!live) return null;
  live.listeners.add(listener);
  return { text: live.text, step: live.step, ended: live.ended, stop: () => live.listeners.delete(listener) };
}
/** Stop the model call of a cancelled session. False when this process is not running it. */
export function abortLive(sessionId: string): boolean {
  const live = runs.get(sessionId);
  if (!live || live.ended) return false;
  live.abort.abort();
  return true;
}
