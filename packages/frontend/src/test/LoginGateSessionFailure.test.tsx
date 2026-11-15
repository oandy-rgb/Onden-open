import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const auth = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  error: null as unknown,
  isPending: false,
  refetch: vi.fn<() => Promise<void>>(),
  signIn: vi.fn(), signUp: vi.fn(),
}));
vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: auth.session, error: auth.error, isPending: auth.isPending, refetch: auth.refetch }),
    signIn: { email: auth.signIn, social: vi.fn() }, signUp: { email: auth.signUp },
  },
  fetchConfiguredProviders: async () => [],
}));
// LoginGate loads its form on use (lazyWithReload); these tests read it right after render.
vi.mock("../lib/lazyWithReload", async () => {
  const { default: LoginForm } = await import("../components/LoginForm");
  return { lazyWithReload: () => LoginForm };
});
import LoginGate from "../components/LoginGate";

beforeEach(() => {
  localStorage.removeItem("onden_verified_account");
  auth.session = null; auth.error = null; auth.isPending = false;
  auth.refetch.mockReset().mockResolvedValue(undefined);
  auth.signIn.mockReset().mockResolvedValue({ error: null });
  auth.signUp.mockReset().mockResolvedValue({ error: null });
});

const unavailable = "Unable to check your sign-in status";

describe("session verification at the login boundary", () => {
  it.each(["login", "signup"])("%s waits for explicit session confirmation after credentials succeed", async mode => {
    let finish!: () => void;
    auth.refetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<LoginGate>private workspace</LoginGate>);
    if (mode === "signup") {
      fireEvent.click(screen.getByText("No account? Sign up"));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Student" } });
    }
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "student@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test input" } });
    fireEvent.click(screen.getByRole("button", { name: mode === "login" ? "Sign in" : "Create account" }));
    await waitFor(() => expect(auth.refetch).toHaveBeenCalledOnce());
    expect(screen.queryByText("private workspace")).toBeNull();
    expect(screen.getByRole("button", { name: "…" })).toBeDisabled();
    expect(screen.getByLabelText("Email")).toHaveValue("student@example.test");
    auth.session = { user: { id: "same-user" } };
    await act(async () => finish());
    // The real session store re-renders the gate when the session arrives; this mock does not.
    rerender(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByText("private workspace")).toBeInTheDocument();
  });

  it.each([new TypeError("Failed to fetch"), { status: 500 }, { status: 503 }, { status: 429 }, { status: 403 }])(
    "shows a retryable verification failure instead of a login form for %j", error => {
      auth.error = error;
      render(<LoginGate>private workspace</LoginGate>);
      expect(screen.getByRole("heading", { name: unavailable })).toBeInTheDocument();
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect(screen.queryByText("private workspace")).toBeNull();
      expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled();
    },
  );

  it.each([null, { status: 401 }])("shows login only for an empty successful session or explicit 401 (%j)", error => {
    auth.error = error;
    render(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByText("private workspace")).toBeNull();
  });

  it("initial verification does not briefly show login or cached content", () => {
    auth.isPending = true;
    render(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByText("private workspace")).toBeNull();
  });

  it("an explicit 401 also refuses stale session data", () => {
    auth.session = { user: { id: "expired-user" } };
    auth.error = { status: 401 };
    render(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByText("private workspace")).toBeNull();
  });

  it("keeps the failure surface stable during retry, then enters after confirmed authentication", async () => {
    auth.error = { status: 503 };
    let finish!: () => void;
    auth.refetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<LoginGate>private workspace</LoginGate>);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    auth.isPending = true; auth.error = null;
    rerender(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByRole("heading", { name: unavailable })).toBeInTheDocument();
    const checkingButton = screen.getByRole("button", { name: "Checking connection…" });
    expect(checkingButton).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(checkingButton);
    expect(auth.refetch).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    auth.isPending = false; auth.session = { user: { id: "same-user" } };
    rerender(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByText("private workspace")).toBeInTheDocument();
  });

  it("a retry confirming no session returns to login", async () => {
    auth.error = { status: 503 };
    const { rerender } = render(<LoginGate>private workspace</LoginGate>);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(auth.refetch).toHaveBeenCalledTimes(1));
    auth.error = null;
    rerender(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("unexpected retry rejection remains recoverable without clearing local input", async () => {
    localStorage.setItem("onden.lostWrites", "saved input fixture");
    auth.error = { status: 503 };
    auth.refetch.mockRejectedValueOnce(new Error("transport failure"));
    const { rerender } = render(<LoginGate>private workspace</LoginGate>);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry connection" })).toHaveAttribute("aria-disabled", "false"));
    auth.error = null;
    rerender(<LoginGate>private workspace</LoginGate>);
    expect(screen.getByRole("heading", { name: unavailable })).toBeInTheDocument();
    expect(localStorage.getItem("onden.lostWrites")).toBe("saved input fixture");
    localStorage.removeItem("onden.lostWrites");
  });

  it("a transient check failure preserves an already-mounted editor and its new input", () => {
    const unmounted = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState("");
      useEffect(() => () => unmounted(), []);
      return <textarea aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />;
    }
    auth.session = { user: { id: "same-user" } };
    const { rerender } = render(<LoginGate><Editor /></LoginGate>);
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "unsaved input" } });
    auth.isPending = true;
    rerender(<LoginGate><Editor /></LoginGate>);
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved input");
    expect(unmounted).not.toHaveBeenCalled();
    auth.isPending = false;
    auth.error = { status: 503 };
    rerender(<LoginGate><Editor /></LoginGate>);
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved input");
    expect(unmounted).not.toHaveBeenCalled();
    auth.error = null; auth.session = null;
    rerender(<LoginGate><Editor /></LoginGate>);
    expect(screen.queryByLabelText("Draft")).toBeNull();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  // GAP-20: offline cold start opens the account this device last verified.
  describe("offline start with a previously verified account", () => {
    function verifyOnce() {
      auth.session = { user: { id: "same-user" } };
      const view = render(<LoginGate>private workspace</LoginGate>);
      view.unmount();
      auth.session = null;
    }

    it.each([new TypeError("Failed to fetch"), { status: 503 }])("opens the verified account's workspace when the check cannot reach the server (%j)", error => {
      verifyOnce();
      auth.error = error;
      render(<LoginGate>private workspace</LoginGate>);
      expect(screen.getByText("private workspace")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: unavailable })).toBeNull();
    });

    it("a device that never verified an account stays locked", () => {
      auth.error = new TypeError("Failed to fetch");
      render(<LoginGate>private workspace</LoginGate>);
      expect(screen.getByRole("heading", { name: unavailable })).toBeInTheDocument();
      expect(screen.queryByText("private workspace")).toBeNull();
    });

    it("a 401 forgets the account, so a later offline start stays locked", () => {
      verifyOnce();
      auth.error = { status: 401 };
      render(<LoginGate>private workspace</LoginGate>).unmount();
      expect(localStorage.getItem("onden_verified_account")).toBeNull();
      auth.error = new TypeError("Failed to fetch");
      render(<LoginGate>private workspace</LoginGate>);
      expect(screen.queryByText("private workspace")).toBeNull();
    });

    it("rechecks when the connection returns, keeping the workspace mounted while it runs", () => {
      verifyOnce();
      auth.error = new TypeError("Failed to fetch");
      const { rerender } = render(<LoginGate>private workspace</LoginGate>);
      act(() => { window.dispatchEvent(new Event("online")); });
      expect(auth.refetch).toHaveBeenCalledTimes(1);
      auth.error = null; auth.isPending = true;
      rerender(<LoginGate>private workspace</LoginGate>);
      expect(screen.getByText("private workspace")).toBeInTheDocument();
      auth.isPending = false; auth.error = { status: 401 };
      rerender(<LoginGate>private workspace</LoginGate>);
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
      expect(screen.queryByText("private workspace")).toBeNull();
    });

    it("an initial check still shows neither login nor cached content", () => {
      verifyOnce();
      auth.isPending = true;
      render(<LoginGate>private workspace</LoginGate>);
      expect(screen.getByRole("status")).toHaveTextContent("Loading");
      expect(screen.queryByText("private workspace")).toBeNull();
    });
  });
});
