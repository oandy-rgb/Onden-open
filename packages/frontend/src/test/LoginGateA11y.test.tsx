import { describe, it, expect, vi } from "vitest";
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

describe("LoginGate a11y", () => {
  it("associates a visible label with every input (no placeholder-only fields)", () => {
    render(<LoginGate>app</LoginGate>);
    // getByLabelText throws if the accessible name is missing or unassociated.
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("exposes the name label after switching to signup", () => {
    render(<LoginGate>app</LoginGate>);
    fireEvent.click(screen.getByText("No account? Sign up"));
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("announces login errors in an assertive live region", async () => {
    signInEmail.mockResolvedValue({ error: { message: "Bad credentials" } });
    render(<LoginGate>app</LoginGate>);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByText("Sign in"));
    const alert = await waitFor(() => screen.getByRole("alert"));
    // The auth library's own text is never shown; the plain fallback is.
    expect(alert.textContent).toBe("Login failed");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
  });

  it.each(["login", "signup"])("explains a refused origin during %s without clearing input or entering the workspace", async mode => {
    const handler = mode === "login" ? signInEmail : signUpEmail;
    handler.mockResolvedValue({ error: { code: "INVALID_ORIGIN", message: "Invalid origin", status: 403 } });
    render(<LoginGate>private workspace</LoginGate>);
    if (mode === "signup") {
      fireEvent.click(screen.getByText("No account? Sign up"));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Student" } });
    }
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "student@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "retained input" } });
    fireEvent.click(screen.getByRole("button", { name: mode === "login" ? "Sign in" : "Create account" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Sign-in is not enabled for ${window.location.origin}`);
    expect(alert).toHaveTextContent("administrator");
    expect(screen.getByLabelText("Email")).toHaveValue("student@example.test");
    expect(screen.getByLabelText("Password")).toHaveValue("retained input");
    expect(screen.queryByText("private workspace")).toBeNull();
    expect(screen.getByRole("button", { name: mode === "login" ? "Sign in" : "Create account" })).toBeEnabled();
  });
});
