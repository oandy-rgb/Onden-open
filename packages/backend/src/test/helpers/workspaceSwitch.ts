// The workspace the round-trip tests' mocked getWorkspaceId() answers with.
// A test moves it between workspaces to export from one and import into
// another through the real routes. No imports, so the vi.mock factory that
// reads it can load it while ../db.js is still being mocked.
export const workspaceSwitch = { ws: "" };
