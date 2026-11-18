/**
 * The one place the MCP server touches the filesystem: writing a `saveImage`
 * payload to a caller-given path. Without `overwrite` the file is opened with
 * the exclusive-create flag `wx`, so an existing file is refused atomically
 * rather than by a check-then-write that a concurrent writer could race.
 * Parent directories are never created.
 */

import { open, unlink } from "node:fs/promises";

type ImageWriteRefusalReason = "exists" | "parent-missing" | "io-error";

export type ImageWriteOutcome =
  | { readonly written: true; readonly bytes: number }
  | {
      readonly written: false;
      readonly reason: ImageWriteRefusalReason;
      readonly message: string;
    };

export type ImageWriter = (
  path: string,
  bytes: Uint8Array,
  overwrite: boolean,
) => Promise<ImageWriteOutcome>;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openRefusal(error: unknown): ImageWriteOutcome {
  const code = errorCode(error);
  const reason: ImageWriteRefusalReason =
    code === "EEXIST"
      ? "exists"
      : code === "ENOENT" || code === "ENOTDIR"
        ? "parent-missing"
        : "io-error";
  return { written: false, reason, message: errorMessage(error) };
}

export const writeImageFile: ImageWriter = async (path, bytes, overwrite) => {
  const handle = await open(path, overwrite ? "w" : "wx").catch(
    (error: unknown) => openRefusal(error),
  );
  if (!("writeFile" in handle)) return handle;
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close().catch(() => undefined);
    // A partial file this call created would otherwise block every retry as "exists".
    if (!overwrite) await unlink(path).catch(() => undefined);
    return { written: false, reason: "io-error", message: errorMessage(error) };
  }
  await handle.close();
  return { written: true, bytes: bytes.length };
};

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

const ASCII = (text: string): number[] =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

/** The image type named by the file's magic number, or undefined when it is not PNG, JPEG, GIF or WebP. */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, ASCII("GIF87a")) ||
    startsWith(bytes, ASCII("GIF89a"))
  ) {
    return "image/gif";
  }
  if (startsWith(bytes, ASCII("RIFF")) && startsWith(bytes, ASCII("WEBP"), 8)) {
    return "image/webp";
  }
  return undefined;
}
