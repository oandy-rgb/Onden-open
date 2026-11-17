import { sendWrite } from "./onlineWrite";

// The owner's decisions in the inbox: what an AI or a feed wants to do, and the deliveries that failed. Online only.
type Decision = "approve" | "reject";

export const inboxWriter = {
  /** One applied change. */
  decide: (eventId: string, decision: Decision) => sendWrite("POST", `/api/inbox/${eventId}/${decision}`, "{}"),
  /** A whole chain of changes (e.g. one feed fetch's articles). */
  decideGroup: (rootEventId: string, decision: Decision) => sendWrite("POST", `/api/inbox/groups/${rootEventId}/${decision}`, "{}"),
  /** Many independent changes at once: exactly the ids the person's filters showed. */
  decideMany: (eventIds: string[], decision: Decision) =>
    sendWrite<{ decided: number; skipped: Array<{ detail: string }> }>("POST", "/api/inbox/batch", { decision, event_ids: eventIds }),
  /** An outbound action held until the owner agrees. */
  decideHeld: (effectId: string, decision: Decision) => sendWrite("POST", `/api/inbox/approvals/${effectId}/${decision}`, "{}"),
  retryDelivery: (effectId: string) =>
    sendWrite<{ status: "requeued" | "merged" | "superseded" }>("POST", `/api/inbox/failed-effects/${effectId}/retry`, "{}"),
  retryDeliveriesOfKind: (kind: string) =>
    sendWrite<{ requeued: number; merged: number; superseded: number }>("POST", `/api/inbox/failed-effects/kinds/${encodeURIComponent(kind)}/retry`, "{}"),
  dismissDeliveriesOfKind: (kind: string) =>
    sendWrite<{ dismissed: number }>("POST", `/api/inbox/failed-effects/kinds/${encodeURIComponent(kind)}/dismiss`, "{}"),
};
