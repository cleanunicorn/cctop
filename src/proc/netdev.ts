// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Pure parser for the Linux /proc/net/dev format. A leaf module (no I/O, no
// FFI) so it can be unit-tested directly without loading a platform's process
// source; linux.ts supplies the file contents.

import type { IfCounters } from "./types.ts";

// Parse the body of Linux /proc/net/dev into per-interface byte counters.
// Format: a two-line header, then one line per interface:
//   "  eth0: <rx bytes> <rx packets> ... <tx bytes> <tx packets> ...".
// The name is left of the colon; right of it, field 0 is rx bytes and field 8
// is tx bytes. One row per interface (no per-address-family duplicates), so the
// name alone identifies it. Counters are 64-bit here, no wrap concern.
export function parseProcNetDev(text: string): IfCounters[] {
  const out: IfCounters[] = [];
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue; // header lines have no colon
    const name = line.slice(0, colon).trim();
    if (name === "lo") continue; // loopback
    const f = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    out.push({ name, rx: Number(f[0]) || 0, tx: Number(f[8]) || 0 });
  }
  return out;
}
