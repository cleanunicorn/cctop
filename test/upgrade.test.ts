// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import {
  assertValidOverrides,
  assetName,
  compareVersions,
  extractFromTar,
  parseChecksums,
  tagFromLocation,
} from "../src/upgrade.ts";

const enc = new TextEncoder();

// Build a single ustar file entry (a 512-byte header + null-padded data) — just
// the fields extractFromTar reads (name, size, typeflag) plus a correct header
// checksum, so a real `tar` would also accept it.
function ustarEntry(
  name: string,
  data: Uint8Array,
  typeflag = "0",
): Uint8Array {
  const buf = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  buf.set(enc.encode(name), 0);
  buf.set(enc.encode("000644 "), 100); // mode
  buf.set(enc.encode(`${data.length.toString(8).padStart(11, "0")} `), 124);
  buf[156] = typeflag.charCodeAt(0); // typeflag ("0" = regular file, "x" = pax)
  buf.set(enc.encode("ustar\0"), 257);
  buf.set(enc.encode("00"), 263);
  for (let i = 148; i < 156; i++) buf[i] = 0x20; // checksum field as spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  buf.set(data, 512);
  return buf;
}

function tarOf(entries: Array<[string, Uint8Array, string?]>): Uint8Array {
  const parts = entries.map(([n, d, tf]) => ustarEntry(n, d, tf));
  const end = new Uint8Array(1024); // two zero blocks terminate the archive
  const out = new Uint8Array(
    parts.reduce((a, p) => a + p.length, 0) + end.length,
  );
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  out.set(end, off);
  return out;
}

const bytes = (u: Uint8Array | null) => (u ? Array.from(u) : null);

describe("assetName", () => {
  test("maps platform/arch to the release asset", () => {
    expect(assetName("linux", "x64")).toBe("cctop_linux_amd64.tar.gz");
    expect(assetName("linux", "arm64")).toBe("cctop_linux_arm64.tar.gz");
    expect(assetName("darwin", "x64")).toBe("cctop_darwin_amd64.tar.gz");
    expect(assetName("darwin", "arm64")).toBe("cctop_darwin_arm64.tar.gz");
  });

  test("rejects unsupported platforms and arches", () => {
    expect(() => assetName("win32", "x64")).toThrow();
    expect(() => assetName("linux", "ia32")).toThrow();
  });
});

describe("compareVersions", () => {
  test("orders releases numerically, not lexically", () => {
    expect(compareVersions("v0.5.0", "v0.4.1")).toBe(1);
    expect(compareVersions("v0.4.1", "v0.5.0")).toBe(-1);
    expect(compareVersions("v0.4.1", "v0.4.1")).toBe(0);
    expect(compareVersions("v0.10.0", "v0.9.9")).toBe(1);
    expect(compareVersions("v1.0.0", "v0.99.99")).toBe(1);
  });

  test("tolerates a missing leading v", () => {
    expect(compareVersions("0.4.1", "v0.4.1")).toBe(0);
    expect(compareVersions("0.5.0", "v0.4.1")).toBe(1);
  });

  test("handles version cores of unequal length", () => {
    expect(compareVersions("v1.2", "v1.2.0")).toBe(0);
    expect(compareVersions("v1.3", "v1.2.5")).toBe(1);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });

  test("a prerelease sorts below its release", () => {
    expect(compareVersions("v0.5.0", "v0.5.0-rc.1")).toBe(1);
    expect(compareVersions("v0.5.0-rc.1", "v0.5.0")).toBe(-1);
    expect(compareVersions("v0.5.0-rc.2", "v0.5.0-rc.1")).toBe(1);
  });

  test("orders prerelease identifiers numerically, not lexically", () => {
    expect(compareVersions("v0.5.0-rc.10", "v0.5.0-rc.2")).toBe(1);
    expect(compareVersions("v0.5.0-rc.2", "v0.5.0-rc.10")).toBe(-1);
    expect(compareVersions("v0.5.0-alpha", "v0.5.0-beta")).toBe(-1);
    expect(compareVersions("v0.5.0-rc.1", "v0.5.0-rc.1.1")).toBe(-1);
  });
});

describe("tagFromLocation", () => {
  test("reads the tag from a releases/latest redirect", () => {
    expect(
      tagFromLocation(
        "https://github.com/stefanprodan/cctop/releases/tag/v0.5.0",
      ),
    ).toBe("v0.5.0");
    expect(
      tagFromLocation("https://github.com/o/r/releases/tag/v1.2.3-rc.1?x=1"),
    ).toBe("v1.2.3-rc.1");
  });

  test("returns null without a tag", () => {
    expect(tagFromLocation(null)).toBeNull();
    expect(tagFromLocation("https://github.com/o/r/releases")).toBeNull();
  });
});

describe("parseChecksums", () => {
  const txt = [
    "cc9310a4ec006a67c8db526f3d821eadf7580d452b6093c7158e976f6b555e28  cctop_darwin_amd64.tar.gz",
    "776e430e8897411432de6427502d9d39f8b4bab95b2532e7ae80b1b57218d53b  cctop_linux_amd64.tar.gz",
  ].join("\n");

  test("finds the hex recorded for an asset", () => {
    expect(parseChecksums(txt, "cctop_linux_amd64.tar.gz")).toBe(
      "776e430e8897411432de6427502d9d39f8b4bab95b2532e7ae80b1b57218d53b",
    );
  });

  test("returns null for an asset it doesn't list", () => {
    expect(parseChecksums(txt, "cctop_linux_arm64.tar.gz")).toBeNull();
  });

  test("tolerates the binary-mode * marker", () => {
    const hex = "ab".repeat(32);
    expect(
      parseChecksums(
        `${hex} *cctop_linux_amd64.tar.gz`,
        "cctop_linux_amd64.tar.gz",
      ),
    ).toBe(hex);
  });

  test("normalizes uppercase hex to lowercase", () => {
    const hex = "AB".repeat(32);
    expect(
      parseChecksums(
        `${hex}  cctop_linux_amd64.tar.gz`,
        "cctop_linux_amd64.tar.gz",
      ),
    ).toBe("ab".repeat(32));
  });
});

describe("extractFromTar", () => {
  test("returns the bytes of the named regular file", () => {
    const data = enc.encode("hello cctop");
    const tar = tarOf([
      ["LICENSE", enc.encode("Apache-2.0")],
      ["cctop", data],
    ]);
    expect(bytes(extractFromTar(tar, "cctop"))).toEqual(bytes(data));
  });

  test("matches a trailing /name (./cctop)", () => {
    const data = enc.encode("x".repeat(1000));
    expect(bytes(extractFromTar(tarOf([["./cctop", data]]), "cctop"))).toEqual(
      bytes(data),
    );
  });

  test("returns null when the entry is absent", () => {
    const tar = tarOf([["README", enc.encode("y")]]);
    expect(extractFromTar(tar, "cctop")).toBeNull();
  });

  test("survives a gzip round-trip (as the real archives arrive)", () => {
    const data = enc.encode("z".repeat(5000));
    const gz = Bun.gzipSync(tarOf([["cctop", data]]));
    expect(bytes(extractFromTar(Bun.gunzipSync(gz), "cctop"))).toEqual(
      bytes(data),
    );
  });

  test("skips a pax/long-name header and returns the following regular file", () => {
    // GitHub archives can carry a pax header (typeflag "x") before the file; a
    // same-named pax entry must be skipped, not returned as the binary.
    const pax = enc.encode("30 path=cctop\n");
    const data = enc.encode("real-binary".repeat(200));
    const tar = tarOf([
      ["cctop", pax, "x"],
      ["cctop", data, "0"],
    ]);
    expect(bytes(extractFromTar(tar, "cctop"))).toEqual(bytes(data));
  });

  test("clamps an entry whose size overruns the archive (no over-read)", () => {
    // A header claiming more bytes than the archive holds must not read past the
    // end; the clamped short result is rejected downstream by the size guard.
    const data = enc.encode("x".repeat(600)); // spans two 512-byte blocks
    const truncated = tarOf([["cctop", data]]).subarray(0, 512 + 400);
    const got = extractFromTar(truncated, "cctop");
    expect(got).not.toBeNull();
    expect(got?.length).toBeLessThanOrEqual(400);
  });

  test("returns null on a header truncated below one block", () => {
    const tar = tarOf([["cctop", enc.encode("y".repeat(300))]]);
    expect(extractFromTar(tar.subarray(0, 200), "cctop")).toBeNull();
  });
});

describe("assertValidOverrides", () => {
  const saved = {
    repo: process.env.CCTOP_REPO,
    version: process.env.CCTOP_VERSION,
  };
  const set = (repo?: string, version?: string) => {
    if (repo === undefined) delete process.env.CCTOP_REPO;
    else process.env.CCTOP_REPO = repo;
    if (version === undefined) delete process.env.CCTOP_VERSION;
    else process.env.CCTOP_VERSION = version;
  };
  afterEach(() => set(saved.repo, saved.version));

  test("accepts no overrides", () => {
    set(undefined, undefined);
    expect(() => assertValidOverrides()).not.toThrow();
  });

  test("accepts well-formed overrides", () => {
    for (const [repo, version] of [
      ["owner/name", "v0.5.0"],
      ["stefanprodan/cctop", "0.5.0"],
      ["a-b.c/d_e", "v1.2.3-rc.1"],
      ["o/n", "v1.2.3-beta-2"], // hyphenated prerelease identifier
    ] as const) {
      set(repo, version);
      expect(() => assertValidOverrides()).not.toThrow();
    }
  });

  test("rejects a malformed repo", () => {
    set("not a repo!", undefined);
    expect(() => assertValidOverrides()).toThrow(/CCTOP_REPO/);
    set("owner/name/extra", undefined);
    expect(() => assertValidOverrides()).toThrow(/CCTOP_REPO/);
  });

  test("rejects a malformed version", () => {
    set(undefined, "latest");
    expect(() => assertValidOverrides()).toThrow(/CCTOP_VERSION/);
    set(undefined, "1.2");
    expect(() => assertValidOverrides()).toThrow(/CCTOP_VERSION/);
  });
});
