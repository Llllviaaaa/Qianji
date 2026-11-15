/**
 * Pre-read hygiene guards and UTF-8 BOM handling for `@qianji/tool-fs`.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
export const MAX_TEXT_READ_BYTES = 32 * 1024 * 1024;
export const FILE_SNIFF_BYTES = 8192;

/**
 * Strip a leading UTF-8 BOM (`\uFEFF`) if present and report whether one was found.
 */
export function stripBom(text: string): { hasBom: boolean; text: string } {
  if (text.startsWith("\uFEFF")) {
    return { hasBom: true, text: text.slice(1) };
  }
  return { hasBom: false, text };
}

function hasUtf16Bom(head: Buffer): boolean {
  if (head.length < 2) return false;
  return (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
}

/**
 * Inspect file metadata and leading bytes before loading the whole file into memory.
 * Returns an actionable error string when the file should be rejected, or `undefined` when safe.
 */
export function inspectFileBeforeRead(filePath: string, isImage: boolean): string | undefined {
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    return "Path is a directory; use ls to inspect its entries.";
  }
  if (isImage) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return `Image file is too large (${stat.size} bytes; maximum allowed is ${MAX_IMAGE_BYTES} bytes / 4.5 MB). Resize or compress the image before reading it.`;
    }
    return undefined;
  }
  if (stat.size > MAX_TEXT_READ_BYTES) {
    return `File is too large to read as text (${stat.size} bytes; maximum allowed is ${MAX_TEXT_READ_BYTES} bytes / 32 MB). Use grep or bash to inspect a smaller slice.`;
  }
  if (stat.size === 0) return undefined;

  const sampleSize = Math.min(stat.size, FILE_SNIFF_BYTES);
  const sample = Buffer.allocUnsafe(sampleSize);
  const fd = openSync(filePath, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < sampleSize) {
      const n = readSync(fd, sample, bytesRead, sampleSize - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
  } finally {
    closeSync(fd);
  }
  const head = sample.subarray(0, bytesRead);
  if (hasUtf16Bom(head)) {
    return `Cannot read binary/UTF-16 encoded file (${stat.size} bytes; detected UTF-16 BOM). Convert the file to UTF-8 before reading or editing.`;
  }
  if (head.includes(0)) {
    return `Cannot read binary file (${stat.size} bytes; detected NUL 0x00 byte in first ${bytesRead} bytes).`;
  }
  return undefined;
}
