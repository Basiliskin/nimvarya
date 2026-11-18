import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sniffMimeType, writeImageFile } from "./image-writer.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nimvarya-image-writer-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

describe("writeImageFile", () => {
  it("writes a new file and reports the byte count that is on disk", async () => {
    const target = join(dir, "fresh.png");

    const outcome = await writeImageFile(target, PNG, false);

    expect(outcome).toEqual({ written: true, bytes: PNG.length });
    expect((await readFile(target)).equals(PNG)).toBe(true);
    expect((await stat(target)).size).toBe(PNG.length);
  });

  it("refuses an existing file without overwrite and leaves its bytes and mtime unchanged", async () => {
    const target = join(dir, "existing.png");
    const original = Buffer.from("original contents");
    await writeFile(target, original);
    const before = await stat(target);

    const outcome = await writeImageFile(target, PNG, false);

    expect(outcome).toMatchObject({ written: false, reason: "exists" });
    expect((await readFile(target)).equals(original)).toBe(true);
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
  });

  it("replaces an existing file when overwrite is true", async () => {
    const target = join(dir, "replace.png");
    await writeFile(target, "a much longer original file body than the png");

    const outcome = await writeImageFile(target, PNG, true);

    expect(outcome).toEqual({ written: true, bytes: PNG.length });
    expect((await readFile(target)).equals(PNG)).toBe(true);
  });

  it("lets exactly one of two simultaneous non-overwrite writes to one path win", async () => {
    const target = join(dir, "race.png");

    const outcomes = await Promise.all([
      writeImageFile(target, PNG, false),
      writeImageFile(target, Buffer.from([0xff, 0xd8, 0xff]), false),
    ]);

    expect(outcomes.filter((o) => o.written)).toHaveLength(1);
    expect(
      outcomes.filter((o) => !o.written && o.reason === "exists"),
    ).toHaveLength(1);
  });

  it("refuses a path whose parent folder is missing, and never creates it", async () => {
    const outcome = await writeImageFile(
      join(dir, "missing", "x.png"),
      PNG,
      false,
    );

    expect(outcome).toMatchObject({ written: false, reason: "parent-missing" });
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });

  it("maps any other open failure to io-error", async () => {
    const outcome = await writeImageFile(dir, PNG, true);

    expect(outcome).toMatchObject({ written: false, reason: "io-error" });
  });
});

describe("sniffMimeType", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ["image/gif", Buffer.from("GIF89a....")],
    ["image/gif", Buffer.from("GIF87a....")],
    ["image/webp", Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")],
  ])("recognises %s from its magic number", (expected, bytes) => {
    expect(sniffMimeType(bytes)).toBe(expected);
  });

  it("returns undefined for unknown or too-short bytes", () => {
    expect(sniffMimeType(Buffer.from("plain text"))).toBeUndefined();
    expect(
      sniffMimeType(Buffer.from("RIFF\x10\x00\x00\x00WAVE", "latin1")),
    ).toBeUndefined();
    expect(sniffMimeType(new Uint8Array())).toBeUndefined();
  });
});
