import type { TagFunctionSpec } from "../../lib/tagModules";

/** What a function looks like once it is on, for the preview card shown before
 *  it is turned on (the paragraph panel's 「試試功能」): `result` is the sentence
 *  about the block or note, `sampleTitle` / `sampleDetail` fill the sample note
 *  under it (all i18n keys). One entry per catalog function, keyed by its id;
 *  guards/tag-function-catalog.guard.test.ts fails for a function without one.
 *  Kept here, not on the spec, so the boot registry carries no preview copy. */
export type FunctionExample = { result: string; sampleTitle: string; sampleDetail: string };

export const FUNCTION_EXAMPLES: Readonly<Record<string, FunctionExample>> = {
  review_block: { result: "This block becomes a card that comes back on a review schedule.", sampleTitle: "What is spaced repetition?", sampleDetail: "Next review: tomorrow" },
  tasks_line: { result: "This note gets a checkbox you can tick off when it is done.", sampleTitle: "Book the dentist", sampleDetail: "Not done yet" },
  skills: { result: "Your AI can now use this note as a way of getting things done.", sampleTitle: "Write a weekly review", sampleDetail: "Available to your AI" },
};

/** The example of a function, if the catalog has one for `fn`. */
export function exampleOf(fn: Pick<TagFunctionSpec, "id">): FunctionExample | undefined {
  return FUNCTION_EXAMPLES[fn.id];
}
