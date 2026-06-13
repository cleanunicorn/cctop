// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  BOLD,
  CYAN,
  formatDuration,
  formatMem,
  formatTokens,
  pad,
  RESET,
  sanitizeDisplay,
  shortProject,
  stripAnsi,
  truncate,
  visLen,
} from "../src/format.ts";

describe("format helpers", () => {
  test("formats memory using compact units", () => {
    expect(formatMem(0)).toBe("0M");
    expect(formatMem(512 * 1024 * 1024)).toBe("512M");
    expect(formatMem(1536 * 1024 * 1024)).toBe("1.5G");
  });

  test("formats durations using the largest compact unit", () => {
    expect(formatDuration(-10)).toBe("0s");
    expect(formatDuration(45.9)).toBe("45s");
    expect(formatDuration(12 * 60)).toBe("12m");
    expect(formatDuration(4 * 60 * 60)).toBe("4h");
    expect(formatDuration(9 * 24 * 60 * 60)).toBe("9d");
  });

  test("formats token counts", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_499)).toBe("1k");
    expect(formatTokens(1_500)).toBe("2k");
  });

  test("shortens project paths", () => {
    expect(shortProject(null)).toBe("?");
    expect(shortProject("/Users/alice/src/cctop")).toBe("cctop");
    expect(shortProject("/")).toBe("/");
  });

  test("counts and pads visible width without trusted ANSI styling", () => {
    const styled = `${BOLD}hi${RESET}`;
    expect(visLen(styled)).toBe(2);
    expect(stripAnsi(styled)).toBe("hi");
    expect(pad(`${CYAN}x${RESET}`, 3)).toBe(`${CYAN}x${RESET}  `);
    expect(pad(`${CYAN}x${RESET}`, 3, true)).toBe(`  ${CYAN}x${RESET}`);
  });

  test("sanitizes terminal controls from untrusted display text", () => {
    const unsafe = "one\x1b[2Jtwo\x1b]52;c;secret\x07three\nfour\x9b31m";
    expect(sanitizeDisplay(unsafe)).toBe("onetwothree four 31m");
  });

  test("truncates with an ellipsis", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 4)).toBe("hel…");
    expect(truncate("hello", 1)).toBe("h");
  });
});
