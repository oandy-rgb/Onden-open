// POST /api/publish the way the app sends it: preview the candidate, then publish exactly that one by its hash
// (the route refuses a publish without the hash: modules/website/routes.ts). `call` posts `body` to a path.

export type PostJson = (path: string, body: Record<string, unknown>) => Response | Promise<Response>;

/** The preview's refusal when the preview itself fails (a bad body), else the publish's answer. */
export async function publishWithPreview(call: PostJson, body: Record<string, unknown> = {}): Promise<Response> {
  const preview = await call("/api/publish/preview", body);
  if (!preview.ok) return preview;
  const { hash } = (await preview.json()) as { hash: string };
  return call("/api/publish", { ...body, preview_hash: hash });
}

/** `call` for a Hono app (or anything with `request`): a JSON POST. */
export const postVia = (app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }): PostJson =>
  async (path, body) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
