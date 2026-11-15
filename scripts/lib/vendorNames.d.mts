export const VENDOR_NAMES: RegExp;
export function productFiles(path: string, options?: { exts?: RegExp }): string[];
export function vendorHits(files: string[], exemptFolder?: string): string[];
export function protocolFolder(): string;
