import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Mock the auth client so the test never touches the network. `providers`
// is a mutable holder set per-test before render to drive provider gating.
const signInSocial = vi.fn();
const providers = { value: [] as string[] };
vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
    signIn: { email: vi.fn(), social: (...a: unknown[]) => signInSocial(...a) },
    signUp: { email: vi.fn() },
  },
  fetchConfiguredProviders: () => Promise.resolve([...providers.value]),
}));

import LoginGate from "../components/LoginGate";

describe("LoginGate — OAuth provider gating", () => {
  beforeEach(() => {
    providers.value = [];
    signInSocial.mockReset();
  });

  it("shows NO social buttons when the backend reports no providers (self-host default)", async () => {
    providers.value = [];
    render(<LoginGate>app</LoginGate>);
    // The form's file loads on use (this file keeps the real lazy path), so wait for it: the first
    // load in a cold worker can take over a second. The email/password form is always there.
    expect(await screen.findByLabelText("Email", {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    // Give the providers' answer a tick; no social buttons appear.
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeTruthy());
    expect(screen.queryByText(/Continue with/i)).toBeNull();
  });

  it("shows ONLY the configured provider's button", async () => {
    providers.value = ["github"];
    render(<LoginGate>app</LoginGate>);
    await waitFor(() => expect(screen.getByText("Continue with GitHub")).toBeTruthy());
    expect(screen.queryByText("Continue with Google")).toBeNull();
    // email/password still present alongside
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("shows both buttons + an 'or' divider when both providers are configured", async () => {
    providers.value = ["github", "google"];
    render(<LoginGate>app</LoginGate>);
    await waitFor(() => expect(screen.getByText("Continue with GitHub")).toBeTruthy());
    expect(screen.getByText("Continue with Google")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("invokes authClient.signIn.social with the provider and a callbackURL on click", async () => {
    signInSocial.mockResolvedValue({});
    providers.value = ["github"];
    render(<LoginGate>app</LoginGate>);
    const btn = await waitFor(() => screen.getByText("Continue with GitHub"));
    btn.click();
    await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1));
    const arg = signInSocial.mock.calls[0][0] as { provider: string; callbackURL: string };
    expect(arg.provider).toBe("github");
    expect(typeof arg.callbackURL).toBe("string");
  });

  it("explains an origin refusal and restores the social login button", async () => {
    providers.value = ["github"];
    signInSocial.mockResolvedValue({ error: { code: "INVALID_ORIGIN", message: "Invalid origin" } });
    render(<LoginGate>app</LoginGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Sign-in is not enabled for ${window.location.origin}`);
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
  });
});
