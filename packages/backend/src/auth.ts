import { betterAuth } from "better-auth";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./authPasswordRules.js";
import { APIError } from "better-auth/api";
import { Kysely, PostgresDialect } from "kysely";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { pool } from "./db.js";
import { authClientIpOptions } from "./authClientIp.js";
import { signupInviteAnswer, inviteTokenFrom, type InviteRefusal } from "./services/actorInvites.js";
import { config, processEnv } from "./config.js";

const db = new Kysely<Record<string, unknown>>({
  dialect: new PostgresDialect({ pool }),
});

// The auth secret signs session cookies. The dev fallback keeps local boot
// zero-config, but it is PUBLIC (it's in this file) — a production deployment
// running on it would accept forged sessions from anyone who read the source.
// Same posture as nativeBypass.ts: the convenience is force-closed in
// production. But we DON'T want zero-config self-host (a phone-Notes / student
// newcomer running `docker compose up`) to throw on first boot — that's an
// onboarding cliff. So when BETTER_AUTH_SECRET is unset in production we
// auto-generate a strong random secret ONCE and persist it to the mounted
// content volume; later boots read it back, so sessions survive restarts.
// We still REFUSE the well-known dev fallback (the actual footgun: a secret
// anyone can read in this source file). Exported (DI'd) so the unit test can
// pin the guard + the generate-and-persist path without touching the real FS.
const DEV_FALLBACK_SECRET = "dev-secret-change-in-production";

// Same convention as git.ts STORE: the backend runs with cwd
// /app/packages/backend and `content` is the mounted (persistent) volume.
const SECRET_FILE = join(process.cwd(), "content", ".auth-secret");

export interface AuthSecretStore {
  read(path: string): string | null;
  write(path: string, value: string): void;
}

const fsStore: AuthSecretStore = {
  read(path) {
    try {
      const v = readFileSync(path, "utf8").trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  },
  write(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort hardening; some volume mounts disallow chmod
    }
  },
};

export function resolveAuthSecret(
  env: NodeJS.ProcessEnv = processEnv(),
  store: AuthSecretStore = fsStore,
  secretFile: string = SECRET_FILE,
): string {
  const explicit = env.BETTER_AUTH_SECRET;

  // An explicitly-set secret wins — but never the well-known dev fallback in
  // production: that one is forgeable by anyone who read the source.
  if (explicit) {
    if (env.NODE_ENV === "production" && explicit === DEV_FALLBACK_SECRET) {
      throw new Error(
        "BETTER_AUTH_SECRET is set to the well-known dev fallback. Refusing " +
        "to start in production: session cookies signed with the public dev " +
        "secret are forgeable by anyone. Unset it to auto-generate a random " +
        "secret, or set it to a long random value (openssl rand -hex 32).",
      );
    }
    return explicit;
  }

  // Outside production, the in-source dev fallback keeps local boot zero-config.
  if (env.NODE_ENV !== "production") return DEV_FALLBACK_SECRET;

  // Production + unset: auto-generate once and persist, so zero-config
  // self-host succeeds AND sessions survive restarts.
  const persisted = store.read(secretFile);
  if (persisted) return persisted;
  const generated = randomBytes(32).toString("hex");
  store.write(secretFile, generated);
  return generated;
}

// OAuth social login (GitHub + Google) is OPT-IN per provider: a provider is
// only registered when BOTH its client id AND secret are present in the env.
// An unset provider is simply absent from socialProviders — better-auth never
// learns about it, so a zero-config self-host (no OAuth apps registered) keeps
// the plain email/password form unchanged and nothing crashes. Secrets stay
// env-only and are NEVER echoed; the frontend learns *which* providers exist
// from the ids in `configuredSocialProviders` (no secret material leaves here).
//
// Callback URL the OAuth app must whitelist: `{BETTER_AUTH_URL}/api/auth/callback/{provider}`
// e.g. http://localhost:8787/api/auth/callback/github (dev) — see .env.example.
function buildSocialProviders(env: NodeJS.ProcessEnv = processEnv()) {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return providers;
}

const socialProviders = buildSocialProviders();

/** Provider ids with credentials configured — safe to expose (no secrets). */
export const configuredSocialProviders: string[] = Object.keys(socialProviders);

// Who may create an account. A personal deployment reachable from the network
// must not let a stranger register: every later account is provisioned as a
// workspace viewer, so an open form hands out read access (GAP-237 note).
//   first-only (default) — only the very first account, which becomes the owner
//   open                 — anyone can register (the e2e stack signs up many users)
// Enforced in the user-create hook, so email sign-up and first-time OAuth
// logins are refused alike.
export type SignupMode = "first-only" | "open";

export function resolveSignupMode(env: NodeJS.ProcessEnv = processEnv()): SignupMode {
  const raw = (env.ONDEN_SIGNUP ?? "").trim().toLowerCase();
  if (raw === "" || raw === "first-only") return "first-only";
  if (raw === "open") return "open";
  throw new Error(`ONDEN_SIGNUP must be "first-only" or "open", got "${env.ONDEN_SIGNUP}".`);
}

// A sign-up through the owner's invite link (Settings › Users & Agents, audit
// D110) may go ahead even when sign-up is closed — only with a valid, unused,
// unexpired link whose invited email is the one signing up. Its first sign-in
// then claims the invited member (POST /api/invites/claim).
//
// `invite` answers for the link the sign-up carries: "admitted", a refusal
// (the sign-up brought a link that does not admit it — told apart so the app
// can say "this link expired" rather than "sign-up is closed"), or null (no
// link).
export async function assertSignupAllowed(
  mode: SignupMode,
  hasAnyUser: () => Promise<boolean>,
  invite: () => Promise<"admitted" | InviteRefusal | null> = async () => null,
): Promise<void> {
  if (mode === "open") return;
  if (!(await hasAnyUser())) return;
  const answer = await invite();
  if (answer === "admitted") return;
  if (answer === "invite_expired") {
    throw new APIError("FORBIDDEN", {
      code: "INVITE_EXPIRED",
      message: "This invite link expired — ask the owner for a new one.",
    });
  }
  if (answer === "invite_email_mismatch") {
    throw new APIError("FORBIDDEN", {
      code: "INVITE_EMAIL_MISMATCH",
      message: "This invite is for a different email. Sign up with the email the owner invited.",
    });
  }
  if (answer === "invite_used" || answer === "invite_invalid") {
    throw new APIError("FORBIDDEN", {
      code: "INVITE_INVALID",
      message: "This invite link is no longer valid — ask the owner for a new one.",
    });
  }
  throw new APIError("FORBIDDEN", {
    code: "SIGNUP_CLOSED",
    message: "Sign-up is closed on this server. Ask the owner to invite this email.",
  });
}

const signupMode = resolveSignupMode();

export const auth = betterAuth({
  database: {
    db,
    type: "postgres",
  },
  secret: resolveAuthSecret(),
  baseURL: config.str("BETTER_AUTH_URL") ?? "http://localhost:8787",
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
  },
  // Only the providers whose env vars are set are registered; absent otherwise.
  socialProviders,
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          await assertSignupAllowed(
            signupMode,
            async () => (await pool.query(`SELECT 1 FROM "user" LIMIT 1`)).rows.length > 0,
            () => signupInviteAnswer(inviteTokenFrom(context?.headers ?? context?.request?.headers), user.email),
          );
        },
      },
    },
  },
  advanced: { ipAddress: { ipAddressHeaders: [...authClientIpOptions.ipAddress.ipAddressHeaders] } },
  trustedOrigins: [
    ...(config.str("CORS_ORIGIN") ?? "http://localhost:4321,http://localhost:8787")
      .split(",").map((s) => s.trim()),
    "http://localhost",        // Capacitor Android
    "capacitor://localhost",   // Capacitor iOS
  ],
});

export type Session = typeof auth.$Infer.Session;
