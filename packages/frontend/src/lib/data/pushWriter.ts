import { sendWrite } from "./onlineWrite";

// This browser's reminder subscription, as the server knows it.
export const pushWriter = {
  /** An upsert: safe to repeat, and it hands the device to the account signed in now. */
  register: (subscription: { endpoint?: string; p256dh?: string; auth?: string }) => sendWrite("POST", "/api/push/subscriptions", subscription),
  remove: (endpoint: string) => sendWrite("DELETE", "/api/push/subscriptions", { endpoint }),
};
