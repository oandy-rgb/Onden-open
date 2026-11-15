import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const signInEmail = vi.fn();
const signUpEmail = vi.fn();
vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
    signIn: { email: (...args: unknown[]) => signInEmail(...args), social: vi.fn() },
    signUp: { email: (...args: unknown[]) => signUpEmail(...args) },
  },
  fetchConfiguredProviders: () => Promise.resolve([]),
}));

// LoginGate loads its form on use (lazyWithReload); these tests read it right after render.
vi.mock("../lib/lazyWithReload", async () => {
  const { default: LoginForm } = await import("../components/LoginForm");
  return { lazyWithReload: () => LoginForm };
});
import LoginGate from "../components/LoginGate";

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function loginWith(error: object) {
  signInEmail.mockResolvedValue({ error });
  render(<LoginGate>app</LoginGate>);
  fill("Email", "a@b.com");
  fill("Password", "password123");
  fireEvent.click(screen.getByText("Sign in"));
  return (await waitFor(() => screen.getByRole("alert"))).textContent;
}

describe("LoginGate error wording", () => {
  beforeEach(() => { signInEmail.mockReset(); signUpEmail.mockReset(); });

  it.each([
    [{ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, "Wrong email or password."],
    [{ code: "INVALID_EMAIL", message: "Invalid email" }, "That email address is not valid."],
    [{ code: "PASSWORD_TOO_SHORT", message: "Password too short" }, "Password must be at least 8 characters."],
    [{ code: "PASSWORD_TOO_LONG", message: "Password too long" }, "Password is too long — at most 128 characters."],
    [{ code: "USER_ALREADY_EXISTS", message: "User already exists." }, "This email is already registered. Sign in instead."],
    [{ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", message: "x" }, "This email is already registered. Sign in instead."],
    [{ status: 429, message: "Too many requests. Please try again later." }, "Too many attempts. Try again later."],
  ])("maps %j to its plain sentence", async (error, sentence) => {
    expect(await loginWith(error)).toBe(sentence);
  });

  it("keeps the closed-signup sentence", async () => {
    expect(await loginWith({ code: "SIGNUP_CLOSED" })).toBe(
      "Sign-up is closed on this server. Ask the owner to invite this email.");
  });

  it("shows the generic fallback, never the library text, for unknown codes", async () => {
    const text = await loginWith({ code: "SOMETHING_NEW", message: "Library internal text" });
    expect(text).toBe("Login failed");
  });

  it("states the rule on the sign-up form and blocks a short password without a request", async () => {
    render(<LoginGate>app</LoginGate>);
    fireEvent.click(screen.getByText("No account? Sign up"));
    expect(screen.getByText("At least 8 characters")).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).minLength).toBe(8);
    fill("Name", "Ann");
    fill("Email", "a@b.com");
    fill("Password", "abc");
    fireEvent.submit(screen.getByLabelText("Password").closest("form")!);
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toBe("Password must be at least 8 characters.");
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("shows the rule only when signing up", () => {
    render(<LoginGate>app</LoginGate>);
    expect(screen.queryByText("At least 8 characters")).toBeNull();
  });
});
