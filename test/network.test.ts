// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { diffRate, makeNetSampler } from "../src/collect/network.ts";
import { type IfCounters, parseProcNetDev } from "../src/proc.ts";

const ifs = (
  entries: Record<string, [number, number]>,
): Map<string, IfCounters> =>
  new Map(
    Object.entries(entries).map(([name, [rx, tx]]) => [name, { name, rx, tx }]),
  );

const list = (entries: Record<string, [number, number]>): IfCounters[] =>
  Object.entries(entries).map(([name, [rx, tx]]) => ({ name, rx, tx }));

describe("network throughput", () => {
  test("sums per-interface byte deltas into a per-second rate", () => {
    const last = ifs({ en0: [1000, 2000], en1: [0, 0] });
    const cur = ifs({ en0: [3000, 2000], en1: [500, 100] });
    // rx: (3000-1000)+(500-0)=2500 over 2s = 1250; tx: 0+100=100 over 2s = 50
    expect(diffRate(last, cur, 2)).toEqual({ rx: 1250, tx: 50 });
  });

  test("clamps per interface so one wrap can't mask another's traffic", () => {
    // en0's 32-bit counter wrapped (4.0e9 -> 0.5e9, a negative delta) while en1
    // genuinely moved 0.5e9. Clamping the *total* would net to negative and
    // report 0, losing en1's real traffic; per-interface clamping keeps it.
    const last = ifs({ en0: [4.0e9, 0], en1: [1.0e9, 0] });
    const cur = ifs({ en0: [0.5e9, 0], en1: [1.5e9, 0] });
    expect(diffRate(last, cur, 1)).toEqual({ rx: 0.5e9, tx: 0 });
  });

  test("ignores interfaces with no prior baseline (just appeared)", () => {
    const last = ifs({ en0: [1000, 1000] });
    const cur = ifs({ en0: [1000, 1000], en5: [9e9, 9e9] });
    // en5 has no baseline; its huge cumulative counter must not become a spike
    expect(diffRate(last, cur, 1)).toEqual({ rx: 0, tx: 0 });
  });

  test("drops an interface that disappears (down/removed) without spiking", () => {
    const last = ifs({ en0: [1000, 1000], en9: [5e9, 5e9] });
    const cur = ifs({ en0: [2000, 1000] }); // en9 gone
    expect(diffRate(last, cur, 1)).toEqual({ rx: 1000, tx: 0 });
  });
});

describe("net sampler state machine", () => {
  test("returns null on the first sample (no baseline)", () => {
    const sample = makeNetSampler(() => list({ en0: [1000, 1000] }));
    expect(sample(1000)).toBeNull();
  });

  test("deltas the second sample against the first", () => {
    const reads = [list({ en0: [1000, 0] }), list({ en0: [3000, 0] })];
    let i = 0;
    const sample = makeNetSampler(() => reads[i++]);
    expect(sample(1000)).toBeNull();
    expect(sample(3000)).toEqual({ rx: 1000, tx: 0 }); // 2000 over 2s
  });

  test("returns null when two samples land within the 200ms guard", () => {
    const reads = [list({ en0: [0, 0] }), list({ en0: [1e6, 0] })];
    let i = 0;
    const sample = makeNetSampler(() => reads[i++]);
    sample(1000);
    expect(sample(1150)).toBeNull(); // 150ms apart, below the floor
  });

  test("a failed read returns null without poisoning the baseline", () => {
    // good, fail, good: the third sample must delta against the FIRST (1s gap
    // restored), not treat the whole cumulative counter as a one-tick spike
    const reads: (IfCounters[] | null)[] = [
      list({ en0: [1000, 0] }),
      null,
      list({ en0: [2000, 0] }),
    ];
    let i = 0;
    const sample = makeNetSampler(() => reads[i++]);
    expect(sample(1000)).toBeNull(); // baseline
    expect(sample(2000)).toBeNull(); // read failed
    expect(sample(2000)).toEqual({ rx: 1000, tx: 0 }); // 1000 over 1s vs first
  });
});

describe("parseProcNetDev", () => {
  const sample = [
    "Inter-|   Receive                    |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo:  12345     100    0    0    0     0          0         0    12345     100    0    0    0     0       0          0",
    "  eth0: 900000     500    0    0    0     0          0         0   300000     250    0    0    0     0       0          0",
    "  wlan0:     7       1    0    0    0     0          0         0        9       1    0    0    0     0       0          0",
    "",
  ].join("\n");

  test("extracts rx (field 0) / tx (field 8) per interface, skipping lo", () => {
    expect(parseProcNetDev(sample)).toEqual([
      { name: "eth0", rx: 900000, tx: 300000 },
      { name: "wlan0", rx: 7, tx: 9 },
    ]);
  });

  test("tolerates an empty/garbage body", () => {
    expect(parseProcNetDev("")).toEqual([]);
    expect(parseProcNetDev("no colons here\n")).toEqual([]);
  });
});
