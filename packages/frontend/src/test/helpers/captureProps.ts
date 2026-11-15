// What the shell hands the capture box (components/workspace/WorkspaceOverlays),
// with an inbox tag already made, so a capture with no place has somewhere to go.
import { vi } from "vitest";
import type { ComponentProps } from "react";
import type { Tag } from "../../lib/api";
import type QuickCapture from "../../modules/capture/QuickCapture";

export const INBOX_TAG_ID = "inbox-tag";
export const INBOX_TAG = { id: INBOX_TAG_ID, name: "收件匣", schema_module: "capture", schema_id: "schema-inbox" } as unknown as Tag;

export type CaptureProps = ComponentProps<typeof QuickCapture>;

export function captureProps(over: Partial<CaptureProps> = {}): CaptureProps {
  return { online: true, nodes: [], tags: [INBOX_TAG], create: vi.fn(async () => null), kinds: [], onMore: vi.fn(), onRefresh: vi.fn(), ...over };
}
