import { afterEach, describe, expect, it, vi } from "vitest";
import { settleStage } from "./settleStage";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

function stageWithPendingPicture(): HTMLElement {
  const stage = document.createElement("div");
  const img = document.createElement("img");
  Object.defineProperty(img, "complete", { value: false }); // never arrives
  stage.append(img);
  document.body.append(stage);
  return stage;
}

describe("settling the stage", () => {
  it("ends as soon as it is cancelled, not after the picture timeout, and leaves no listener or observer behind", async () => {
    const stage = stageWithPendingPicture();
    const controller = new AbortController();
    const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const started = Date.now();
    const settling = settleStage(stage, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await settling;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(removed).toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled(); // it was cancelled before it began to watch: nothing was started
  });

  it("starts nothing when it is already cancelled", async () => {
    const watch = vi.spyOn(MutationObserver.prototype, "observe");
    const controller = new AbortController();
    controller.abort();
    await settleStage(stageWithPendingPicture(), controller.signal);
    expect(watch).not.toHaveBeenCalled();
  });

  it("settles once the pictures are in and nothing changes", async () => {
    const stage = document.createElement("div");
    document.body.append(stage);
    await settleStage(stage, new AbortController().signal);
  });
});
