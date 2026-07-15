import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStamp, isCompiledBinary, selfStamp } from "../src/binary.ts";

describe("fileStamp", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cctop-binary-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null for a path that does not exist", () => {
    expect(fileStamp(join(dir, "nope"))).toBeNull();
  });

  test("is stable across repeated calls on an untouched file", () => {
    const p = join(dir, "cctop");
    writeFileSync(p, "one");
    expect(fileStamp(p)).toBe(fileStamp(p) as string);
    expect(fileStamp(p)).not.toBeNull();
  });

  // The upgrade path: a new file renamed over the old name. The stamp must move
  // even though the path is unchanged — that is the whole signal.
  test("changes when a sibling is renamed over the path", () => {
    const p = join(dir, "cctop");
    writeFileSync(p, "old");
    const before = fileStamp(p);

    const staged = join(dir, ".cctop.tmp");
    writeFileSync(staged, "new");
    renameSync(staged, p);

    expect(fileStamp(p)).not.toBe(before as string);
  });

  // Homebrew installs a symlink into bin/; stamping the link itself would never
  // change, so realpath() must resolve to the file that actually gets replaced.
  test("follows a symlink to its target", () => {
    const target = join(dir, "real");
    const link = join(dir, "link");
    writeFileSync(target, "bytes");
    symlinkSync(target, link);
    expect(fileStamp(link)).toBe(fileStamp(target) as string);
  });

  test("returns null for a dangling symlink", () => {
    const link = join(dir, "dangling");
    symlinkSync(join(dir, "missing"), link);
    expect(fileStamp(link)).toBeNull();
  });
});

describe("selfStamp", () => {
  // The test runner executes under the bun interpreter, so there is no single
  // cctop binary to watch. Guards the false positive this protects against:
  // upgrading *bun* must never read as "cctop was updated".
  test("is null when not a compiled standalone binary", () => {
    expect(isCompiledBinary()).toBe(false);
    expect(selfStamp()).toBeNull();
  });
});
