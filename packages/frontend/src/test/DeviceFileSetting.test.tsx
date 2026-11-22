// Settings › 你的資料 › 帶到另一台裝置: the file of all notes is given only to a request that carries a ticket from a fresh confirmation
// (the server checks it; the page gets the ticket through components/ReconfirmDialog.tsx and sends it).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ make: vi.fn(), issue: vi.fn() }));
vi.mock("../lib/deviceFile", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/deviceFile")>()), makeDeviceFile: mocks.make }));
vi.mock("../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/data")>()), freshProof: { issue: mocks.issue } }));

import { DeviceFileSetting } from "../settings/DeviceFileSetting";
import { setLocalOnlyStatus } from "../lib/localOnlyStatus";
import { ApiError } from "../lib/api";

const open = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Make the file…" }));
const refusedWith = (status: number, code: string) => new ApiError(status, JSON.stringify({ error: code })); // the data layer keeps only the code

describe("on the browser version (no password: a press of the button confirms)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocalOnlyStatus({ label: "Only in this browser · saved", trouble: null, open: () => {}, signsInWithoutPassword: true });
  });
  afterEach(() => setLocalOnlyStatus(null));

  it("says what the file is and is not before anything is made, without the words of the format", async () => {
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toMatch(/It is a copy: after that/);
    expect(text).toMatch(/do not update each other/);
    expect(text).toMatch(/not encrypted: anyone who has it can read everything in it/);
    expect(text).not.toMatch(/shared spaces/); // one local person: there is no one else's content in the file
    expect(text).toMatch(/Pictures and files .* not in the file yet/);
    expect(text).not.toMatch(/snapshot|ndjson|json|stamp/i);
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.make).not.toHaveBeenCalled();
  });

  it("the press asks the server for a ticket (an acknowledgement, no password) and the file is asked for with that ticket", async () => {
    mocks.issue.mockResolvedValue("ticket-1");
    mocks.make.mockImplementation(async (_ticket: string, onProgress: (n: number) => void) => { onProgress(2048); return { bytes: 4096, how: "chosen-place" }; });
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    expect(screen.queryByLabelText("Your password, to confirm that it is you")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Make the file" }));
    expect(await screen.findByText(/saved \(1 MB\) where you chose/i)).toBeTruthy();
    expect(mocks.issue).toHaveBeenCalledWith("snapshot_export", { kind: "acknowledgement" });
    expect(mocks.make.mock.calls[0]![0]).toBe("ticket-1");
    expect(screen.getByText(/stays only on that device, until the two can exchange changes/)).toBeTruthy();
  });

  it("a server that wants the password anyway makes the dialog ask for it, and nothing is made meanwhile", async () => {
    mocks.issue.mockRejectedValueOnce(refusedWith(403, "fresh_proof_password_needed"));
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "Make the file" }));
    expect(await screen.findByLabelText("Your password, to confirm that it is you")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Type your password to confirm that it is you.");
    expect(mocks.make).not.toHaveBeenCalled();
  });

  it("a file that arrives cut or refused is said in words and nothing is reported saved; a stale ticket goes back to confirming", async () => {
    mocks.issue.mockResolvedValue("t");
    mocks.make.mockRejectedValueOnce(refusedWith(409, "snapshot_foreign_origin"));
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "Make the file" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This device holds changes from a device it has no record of, so it cannot make a file for another one.");
    expect(screen.getByText("Make the file on the device your notes came from first.")).toBeTruthy();
    mocks.make.mockRejectedValueOnce(new Error("incomplete"));
    await user.click(screen.getByRole("button", { name: "Confirm again" }));
    await user.click(screen.getByRole("button", { name: "Make the file" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not come out whole/);
    expect(screen.queryByText(/is saved/)).toBeNull();
  });

  it("the done screen says the file was handed to the browser (not saved) and that the two devices now write apart", async () => {
    mocks.issue.mockResolvedValue("t");
    mocks.make.mockResolvedValue({ bytes: 5, how: "download" });
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "Make the file" }));
    expect(await screen.findByText(/handed to your browser to download/)).toBeTruthy();
    expect(screen.getByText(/stays only on that device, until the two can exchange changes/)).toBeTruthy();
  });
});

describe("on a server's web app (the password again)", () => {
  beforeEach(() => { vi.clearAllMocks(); setLocalOnlyStatus(null); });

  it("says that a server with other people puts their shared-space notes and the members' names in the file, and that it is not encrypted", async () => {
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toMatch(/shared spaces, including notes other people put there, and the members' names/);
    expect(text).toMatch(/not encrypted: anyone who has it can read everything in it/);
  });

  it("makes nothing until the server accepts the password; the server's refusal is shown in its plain sentence, whatever the cause", async () => {
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    const button = screen.getByRole("button", { name: "Confirm and make the file" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Your password, to confirm that it is you"), "wrong");
    for (const [code, sentence] of [
      ["fresh_proof_wrong_password", "That password is not right."],
      ["fresh_proof_locked", "Too many wrong passwords. Wait a while before trying again."],
      ["fresh_proof_no_password", "This account has no password, so it cannot be confirmed here."],
    ] as const) {
      mocks.issue.mockRejectedValueOnce(refusedWith(403, code));
      await user.click(screen.getByRole("button", { name: "Confirm and make the file" }));
      expect((await screen.findByRole("alert")).textContent).toBe(sentence);
    }
    expect(mocks.make).not.toHaveBeenCalled();
    mocks.issue.mockResolvedValueOnce("ticket-2");
    mocks.make.mockResolvedValue({ bytes: 100, how: "chosen-place" });
    await user.click(screen.getByRole("button", { name: "Confirm and make the file" }));
    expect(await screen.findByText(/saved \(1 MB\) where you chose/i)).toBeTruthy();
    expect(mocks.issue).toHaveBeenLastCalledWith("snapshot_export", { kind: "password", password: "wrong" });
    await waitFor(() => expect(mocks.make.mock.calls[0]![0]).toBe("ticket-2"));
  });

  it("a connection that fails is not said to be a wrong password", async () => {
    mocks.issue.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(<DeviceFileSetting />);
    await open(user);
    await user.type(screen.getByLabelText("Your password, to confirm that it is you"), "x");
    await user.click(screen.getByRole("button", { name: "Confirm and make the file" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be checked right now/);
    expect(mocks.make).not.toHaveBeenCalled();
  });
});
