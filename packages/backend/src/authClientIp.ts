// Which request header better-auth trusts for the client IP (its login and
// sign-up rate limits are bucketed by it). docker/nginx/nginx.conf overwrites
// X-Real-IP with $remote_addr on every proxied location, so it is the only
// header a client cannot choose. better-auth's default is X-Forwarded-For,
// which nginx used to pass through untouched; the production proxy must keep
// overwriting X-Real-IP (docs/agents/deploy.md).
export const authClientIpOptions = {
  ipAddress: { ipAddressHeaders: ["x-real-ip"] },
} as const satisfies { ipAddress: { ipAddressHeaders: string[] } };
