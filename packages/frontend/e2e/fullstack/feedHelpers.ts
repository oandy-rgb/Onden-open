// The stack's own site feed as an RSS source: the articles an RSS spec reads are notes the stack publishes itself.
// A space whose 「發布到網站」 switch is on puts its notes on the site at the next publish (the default space does
// not publish), and the feed serves the last published snapshot, so a spec that wants feed items publishes them here.
import type { APIRequestContext } from "@playwright/test";
import { FEED_ORIGIN, H, createPublishingSpace, publishSite } from "./helpers";

/** Where the BACKEND reads the site feed (docker: the compose `nginx` host; cloud stack: the loopback forwarder).
 *  `?run` makes each test's subscription a distinct source without changing what the feed serves. */
export const siteFeedUrl = (stamp: number): string => `${FEED_ORIGIN}/site/feed.xml?run=${stamp}`;

/** Make one note per title in a publishing space and publish the site, so the feed carries them as items. */
export async function publishFeedArticles(request: APIRequestContext, titles: string[], bodyOf: (index: number) => string): Promise<void> {
  const space_id = await createPublishingSpace(request);
  for (const [index, title] of titles.entries()) {
    const res = await request.post("/api/nodes", { ...H, data: { space_id, title, markdown: bodyOf(index) } });
    if (!res.ok()) throw new Error(`publishFeedArticles: creating "${title}" answered ${res.status()}`);
  }
  await publishSite(request);
}
