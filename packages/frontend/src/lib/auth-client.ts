import { createAuthClient } from "better-auth/react";
import { getApiBase, pageOrigin } from "./api";

// better-auth client appends `/api/auth/*` to baseURL itself, so the
// baseURL must be the SITE ORIGIN, NOT the api prefix. Passing "/api"
// here yields URLs like `/api/sign-in/email` (missing the auth segment)
// → 401. The library also requires an absolute URL during hydration
// (URL constructor throws on relative paths), so resolve at runtime
// against the page origin (pageOrigin in api.ts).
//
// If getApiBase() returns an absolute URL that already contains /api
// (e.g. a pre-shim localStorage value pointing at backend:8787/api),
// strip the trailing /api before passing it through. Otherwise default
// to the current page's origin — same-origin via nginx is the intended
// setup.
function authBaseUrl(): string {
  if (typeof window === "undefined") return "";
  const raw = getApiBase();
  if (!raw) return pageOrigin();
  let abs = raw;
  if (!/^https?:\/\//i.test(raw)) {
    abs = new URL(raw, pageOrigin()).toString();
  }
  return abs.replace(/\/+$/, "").replace(/\/api$/, "");
}

export const authClient = createAuthClient({
  baseURL: authBaseUrl(),
});

export const { signIn, signOut, signUp, useSession } = authClient;

// ── OAuth social providers ────────────────────────────────────────────────
// The set the UI knows how to render a branded button for. A provider id the
// backend reports but we don't recognize here is ignored (forward-compat: the
// server may enable one before the UI ships a button for it).
export const KNOWN_SOCIAL_PROVIDERS = ["github", "google"] as const;
export type SocialProvider = (typeof KNOWN_SOCIAL_PROVIDERS)[number];

/**
 * Parse the `GET /api/auth/providers` payload into the ordered list of
 * provider ids the UI should show. Pure + defensive so it's unit-testable
 * without a network: tolerates a missing/garbage body (→ []), dedupes, drops
 * unknown ids, and preserves KNOWN_SOCIAL_PROVIDERS order for stable layout.
 */
export function parseConfiguredProviders(payload: unknown): SocialProvider[] {
  const raw =
    payload && typeof payload === "object" && Array.isArray((payload as { providers?: unknown }).providers)
      ? (payload as { providers: unknown[] }).providers
      : [];
  const set = new Set(raw.filter((id): id is string => typeof id === "string"));
  return KNOWN_SOCIAL_PROVIDERS.filter((id) => set.has(id));
}

/** Fetch which OAuth providers the deployment has configured. Never throws. */
export async function fetchConfiguredProviders(): Promise<SocialProvider[]> {
  try {
    const base = authBaseUrl();
    const res = await fetch(`${base}/api/auth/providers`, { credentials: "include" });
    if (!res.ok) return [];
    return parseConfiguredProviders(await res.json());
  } catch {
    return [];
  }
}
