export function locate(file: string, repoRoot?: string): { side: "frontend" | "backend"; rel: string } | null;
export function checkEditedFile(file: string, options?: { source?: string; repoRoot?: string; baseline?: Record<string, Record<string, number>> }): Promise<string[]>;
export function editedFileFromHookInput(text: string): string | null;
export function run(stdinText: string, options?: { source?: string; repoRoot?: string; baseline?: Record<string, Record<string, number>> }): Promise<{ code: number; stderr: string }>;
