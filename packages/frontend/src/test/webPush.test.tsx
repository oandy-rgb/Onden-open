import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const calls = vi.hoisted(() => ({ key: vi.fn(), send: vi.fn() }));
vi.mock("../lib/data", () => ({
  reads: { push: { key: calls.key } },
  pushWriter: {
    register: (body: unknown) => calls.send("POST", "/api/push/subscriptions", body),
    remove: (endpoint: string) => calls.send("DELETE", "/api/push/subscriptions", { endpoint }),
  },
}));

const sw = vi.hoisted(() => ({ container: undefined as unknown }));
vi.mock("../lib/storagePersist", () => ({ serviceWorkerContainer: () => sw.container }));

import { _resetPushForTests, disablePush, enablePush, forgetPushDevice, getPushStatus, refreshPushStatus } from "../lib/webPush";
import { pushProblemText } from "../lib/pushProblemText";
import PushRemindersRow from "../settings/PushRemindersRow";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const subscriptionJson = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "pk", auth: "ak" } };

let subscription: null | { toJSON: () => unknown; endpoint: string; unsubscribe: ReturnType<typeof vi.fn> };
let subscribe: ReturnType<typeof vi.fn>;
let permission: NotificationPermission;
const original = { Notification: (globalThis as { Notification?: unknown }).Notification, PushManager: (window as { PushManager?: unknown }).PushManager };

function makeSubscription() {
  return { toJSON: () => subscriptionJson, endpoint: subscriptionJson.endpoint, unsubscribe: vi.fn().mockResolvedValue(true) };
}

beforeEach(() => {
  _resetPushForTests();
  calls.key.mockReset().mockResolvedValue({ public_key: KEY });
  calls.send.mockReset().mockResolvedValue({ ok: true });
  subscription = null;
  subscribe = vi.fn(async () => { subscription = makeSubscription(); return subscription; });
  permission = "granted";
  sw.container = { ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription, subscribe } }) };
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  const NotificationStub = function () {} as unknown as { permission: NotificationPermission; requestPermission: unknown };
  Object.defineProperty(NotificationStub, "permission", { get: () => permission });
  NotificationStub.requestPermission = vi.fn(async () => { permission = "granted"; return permission; });
  (globalThis as unknown as { Notification: unknown }).Notification = NotificationStub;
});
afterEach(() => {
  (globalThis as { Notification?: unknown }).Notification = original.Notification;
  (window as { PushManager?: unknown }).PushManager = original.PushManager;
  delete (navigator as { brave?: unknown }).brave;
});

describe("lock-screen reminders (browser half)", () => {
  it("is not offered when the server has no push keys (404)", async () => {
    calls.key.mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }));
    await refreshPushStatus();
    expect(getPushStatus()).toMatchObject({ available: false, subscribed: false });
    expect(await enablePush()).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    expect(calls.send).not.toHaveBeenCalled();
  });

  it("subscribes the browser with the server's key and tells the server, sending keys but nothing else", async () => {
    await refreshPushStatus();
    expect(getPushStatus()).toMatchObject({ available: true, subscribed: false });
    expect(await enablePush()).toBe(true);
    const options = subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(options.applicationServerKey).toHaveLength(65);
    expect(calls.send).toHaveBeenCalledWith("POST", "/api/push/subscriptions", { endpoint: subscriptionJson.endpoint, p256dh: "pk", auth: "ak" });
    expect(getPushStatus()).toMatchObject({ subscribed: true, problem: null, busy: false });
  });

  it("asks for notification permission first, and says so when it is blocked", async () => {
    permission = "default";
    (Notification.requestPermission as ReturnType<typeof vi.fn>).mockImplementation(async () => { permission = "denied"; return permission; });
    expect(await enablePush()).toBe(false);
    expect(getPushStatus().problem).toBe("blocked");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("points a Brave user at Brave's push setting when subscribing fails", async () => {
    (navigator as unknown as { brave: unknown }).brave = { isBrave: async () => true };
    subscribe.mockRejectedValue(new DOMException("push service error", "AbortError"));
    expect(await enablePush()).toBe(false);
    expect(getPushStatus()).toMatchObject({ subscribed: false, problem: "brave", busy: false });
    expect(pushProblemText("brave")).toContain("Brave");
  });

  it("gives a plain failure (no Brave hint) elsewhere, and when the server refuses the subscription", async () => {
    subscribe.mockRejectedValueOnce(new Error("x"));
    expect(await enablePush()).toBe(false);
    expect(getPushStatus().problem).toBe("failed");
    calls.send.mockRejectedValueOnce(new Error("offline"));
    expect(await enablePush()).toBe(false);
    expect(getPushStatus()).toMatchObject({ problem: "failed", subscribed: false });
    expect(await enablePush()).toBe(true); // the browser kept its subscription; this run just tells the server
  });

  it("re-tells the server about an existing subscription once per page, without asking again", async () => {
    subscription = makeSubscription();
    await refreshPushStatus();
    await refreshPushStatus();
    expect(getPushStatus().subscribed).toBe(true);
    expect(calls.send).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("turns off: the server forgets the device and the browser drops the subscription", async () => {
    await enablePush();
    const sub = subscription!;
    await disablePush();
    expect(calls.send).toHaveBeenLastCalledWith("DELETE", "/api/push/subscriptions", { endpoint: subscriptionJson.endpoint });
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(getPushStatus().subscribed).toBe(false);
  });

  it("still drops the browser subscription when the server cannot be reached; signing out does the same", async () => {
    await enablePush();
    const sub = subscription!;
    calls.send.mockRejectedValue(new Error("offline"));
    await forgetPushDevice();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(getPushStatus().subscribed).toBe(false);
  });

  it("only an installed iPhone/iPad app can get push: elsewhere without PushManager nothing is offered", async () => {
    delete (window as { PushManager?: unknown }).PushManager;
    await refreshPushStatus();
    expect(getPushStatus().available).toBe(false);
  });

  it("problem texts are sentences, never codes or addresses", () => {
    for (const p of ["blocked", "brave", "install", "failed"] as const) expect(pushProblemText(p)).toMatch(/[.。]$/);
  });
});

describe("Settings row", () => {
  it("shows nothing when the server offers no push", async () => {
    calls.key.mockRejectedValue(new Error("404"));
    const { container } = render(<PushRemindersRow online />);
    await waitFor(() => expect(calls.key).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("offers turning it on, then shows it is on with a way to turn it off", async () => {
    render(<PushRemindersRow online />);
    const on = await screen.findByRole("button", { name: /Turn on/ });
    fireEvent.click(on);
    const off = await screen.findByRole("button", { name: /Turn off/ });
    expect(screen.getByText(/even when the screen is locked/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("fcm.googleapis.com");
    fireEvent.click(off);
    await screen.findByRole("button", { name: /Turn on/ });
  });

  it("explains the Brave setting when turning on fails there", async () => {
    (navigator as unknown as { brave: unknown }).brave = { isBrave: async () => true };
    subscribe.mockRejectedValue(new Error("x"));
    render(<PushRemindersRow online />);
    fireEvent.click(await screen.findByRole("button", { name: /Turn on/ }));
    expect(await screen.findByText(/Brave/)).toBeTruthy();
  });

  it("cannot be turned on while offline", async () => {
    render(<PushRemindersRow online={false} />);
    const on = await screen.findByRole("button", { name: /Turn on/ });
    expect((on as HTMLButtonElement).disabled).toBe(true);
  });
});
