// The person's own space known the way the app learns it: the server's spaces list, through lib/spaces refreshSpaces.
// For tests that start today's note or a task's note: a device that has never heard the server refuses to (lib/data/
// dayNotes PersonalSpaceUnknownError), so a test about something else says first that this device knows the space.
import { vi } from "vitest";
import { reads } from "../../lib/data";
import { refreshSpaces, resetSpacesForTest, type Space } from "../../lib/spaces";

export const TEST_PERSONAL_SPACE = "11111111-2222-4333-8444-555555555555";

export async function knowPersonalSpace(id: string = TEST_PERSONAL_SPACE, others: Space[] = []): Promise<void> {
  resetSpacesForTest();
  const personal: Space = { id, name: "me", kind: "personal", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true };
  const answer = vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces: [personal, ...others] } as never);
  try { await refreshSpaces(); } finally { answer.mockRestore(); }
}
