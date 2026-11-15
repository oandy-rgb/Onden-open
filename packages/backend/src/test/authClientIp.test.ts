// better-auth's sign-in rate limit is bucketed by client IP. Behind nginx the
// only trustworthy header is X-Real-IP (nginx overwrites it); a client-chosen
// X-Forwarded-For must neither split one client into many buckets nor merge
// everybody into one. Runs the real limiter with an in-memory store, so no
// database is needed.

import { describe, it, expect, afterAll } from "vitest";
import { betterAuth } from "better-auth";
import { readFileSync } from "node:fs";
import { authClientIpOptions } from "../authClientIp.js";

const prevEnv = process.env.NODE_ENV;
afterAll(() => { process.env.NODE_ENV = prevEnv; });

function makeAuth() {
  return betterAuth({
    secret: "test-secret-test-secret-test-secret-0123456789",
    baseURL: "http://localhost:8787",
    emailAndPassword: { enabled: true },
    advanced: { ipAddress: { ipAddressHeaders: [...authClientIpOptions.ipAddress.ipAddressHeaders] } },
    rateLimit: { enabled: true, storage: "memory" },
    logger: { disabled: true },
  });
}

async function signIn(auth: ReturnType<typeof makeAuth>, headers: Record<string, string>) {
  const res = await auth.handler(new Request("http://localhost:8787/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:8787", ...headers },
    body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-1" }),
  }));
  return res.status;
}

async function burst(auth: ReturnType<typeof makeAuth>, n: number, headers: (i: number) => Record<string, string>) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push(await signIn(auth, headers(i)));
  return statuses;
}

describe("auth login rate limit client IP", () => {
  it("gives two client IPs separate buckets", async () => {
    const auth = makeAuth();
    const a = await burst(auth, 6, () => ({ "x-real-ip": "198.51.100.10" }));
    expect(a).toContain(429);
    // 第二個 IP 沒用過任何額度：第一次嘗試不會被擋。
    expect(await signIn(auth, { "x-real-ip": "198.51.100.11" })).not.toBe(429);
  });

  it("ignores a client-supplied X-Forwarded-For", async () => {
    const auth = makeAuth();
    // 同一個真實 IP、每次換一個偽造的 XFF：仍然落在同一個桶而被限速。
    const statuses = await burst(auth, 6, (i) => ({
      "x-real-ip": "198.51.100.20",
      "x-forwarded-for": `203.0.113.${i + 1}`,
    }));
    expect(statuses).toContain(429);
    // 反過來：XFF 相同、真實 IP 不同，不會被併成同一個桶。
    const other = await signIn(auth, { "x-real-ip": "198.51.100.21", "x-forwarded-for": "203.0.113.1" });
    expect(other).not.toBe(429);
  });

  it("nginx overwrites both client-IP headers on every proxied location", () => {
    const conf = readFileSync(new URL("../../../../docker/nginx/nginx.conf", import.meta.url), "utf8");
    const proxied = conf.match(/proxy_pass http:\/\/(backend|frontend):\d+;/g) ?? [];
    const real = conf.match(/proxy_set_header X-Real-IP \$onden_client_ip;/g) ?? [];
    const xff = conf.match(/proxy_set_header X-Forwarded-For \$onden_client_ip;/g) ?? [];
    // /_astro/ 的 frontend 靜態資源不看 IP；其餘每個 proxy_pass 都要覆寫兩個標頭。
    expect(real.length).toBe(proxied.length - 1);
    expect(xff.length).toBe(real.length);
  });

  it("only the private 8081 listener takes the client IP from X-Real-IP (Caddy)", () => {
    const root = (f: string) => readFileSync(new URL(`../../../../${f}`, import.meta.url), "utf8");
    const conf = root("docker/nginx/nginx.conf");
    const map = conf.match(/map \$server_port \$onden_client_ip \{([^}]*)\}/)?.[1] ?? "";
    expect(map.replace(/\s+/g, " ").trim()).toBe("8081 $http_x_real_ip; default $remote_addr;");
    // 8081 必須只在 compose 網路內：任何 compose 檔都不可把它發佈到主機。
    expect(root("compose.yaml")).not.toMatch(/8081/);
    // Caddy 以「取代」而非附加的方式寫入真實 IP。
    const caddyfile = root("docker/caddy/Caddyfile");
    expect(caddyfile).toContain("reverse_proxy nginx:8081");
    expect(caddyfile).toContain("header_up X-Real-IP {remote_host}");
    expect(caddyfile).toContain("header_up X-Forwarded-For {remote_host}");
  });
});
