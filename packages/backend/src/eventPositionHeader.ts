import type { MiddlewareHandler } from "hono";
import { EVENT_POSITION_HEADER } from "@onden/markdown/contract";
import { collectEventPosition } from "./spine/eventPosition.js";

/** The one place a write's position (spine/eventPosition.ts) reaches the client: EVENT_POSITION_HEADER on a successful
 *  response whose request committed at least one event. A refusal (any status from 300 up) carries none even if
 *  something before it committed, and no event means no header — absence is "no position", never "0" or empty. */
export function eventPositionHeader(): MiddlewareHandler {
  return async (c, next) => {
    const { position } = await collectEventPosition(() => next());
    if (position !== null && c.res.status >= 200 && c.res.status < 300) c.res.headers.set(EVENT_POSITION_HEADER, position);
    else c.res.headers.delete(EVENT_POSITION_HEADER);
  };
}
