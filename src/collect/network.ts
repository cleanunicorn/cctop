// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Machine-wide network throughput: the rate of change of the kernel's
// cumulative interface byte counters, sampled across refreshes — the same
// delta-between-samples trick cpuPercent uses, but for interface counters
// rather than per-pid CPU time. This is host-wide (every interface, all
// traffic), not scoped to Claude: no read-only per-process network counter
// exists on macOS or Linux, so per-session attribution isn't possible without
// root + packet capture. Read-only; reads counters via proc.ts, holds only the
// last sample.

import { type IfCounters, netCounters } from "../proc.ts";

export interface NetRate {
  rx: number; // bytes/sec received
  tx: number; // bytes/sec transmitted
}

// Build a stateful throughput sampler over a counter reader. Each call deltas
// the current reading against the previous one. Factored out from the
// module-level instance below so the stateful edges (first-sample null, the
// min-gap guard, and the failed-read baseline preservation) are testable with
// an injected reader instead of the real platform counters.
export function makeNetSampler(read: () => IfCounters[] | null) {
  let prev: { ifs: Map<string, IfCounters>; atMs: number } | null = null;
  return (nowMs: number): NetRate | null => {
    const cur = read();
    // a failed read must not poison the baseline: keep `prev` so the next good
    // sample deltas against the last good one instead of reporting the whole
    // cumulative counter as a one-tick spike
    if (!cur) return null;

    const ifs = new Map<string, IfCounters>(cur.map((c) => [c.name, c]));
    const last = prev;
    prev = { ifs, atMs: nowMs };
    if (!last || nowMs - last.atMs <= 200) return null;

    return diffRate(last.ifs, ifs, (nowMs - last.atMs) / 1000);
  };
}

const sample = makeNetSampler(netCounters);

// Bytes/sec since the previous call, summed across interfaces. Null on the
// first sample (no baseline), when two samples land within 200ms (too short
// for a meaningful rate), and when the counters can't be read — so the
// single-frame paths (--once/--json/piped) never show a bogus number.
export function netThroughput(nowMs: number): NetRate | null {
  return sample(nowMs);
}

// Sum the per-interface byte deltas and divide by the elapsed seconds. The
// clamp is per interface, not on the total: a 32-bit counter wrap (macOS) or
// reset yields a negative delta for THAT interface. Zeroing only its
// contribution stops one interface's wrap from masking another's traffic — but
// it does NOT recover the wrapping interface's own bytes for that tick (they
// read as 0), so a wrap costs an undercount on that one interface. We don't try
// to add back 2^32: a negative delta is ambiguous between a 32-bit wrap and a
// genuine counter reset (interface re-init), and guessing wrong would invent
// traffic. Acceptable since a wrap needs >4 GiB on one interface between ~1s
// samples. Exported for tests.
export function diffRate(
  last: Map<string, IfCounters>,
  cur: Map<string, IfCounters>,
  dtSec: number,
): NetRate {
  let rx = 0;
  let tx = 0;
  for (const [name, c] of cur) {
    const p = last.get(name);
    if (!p) continue; // interface appeared since last sample: no baseline yet
    rx += Math.max(0, c.rx - p.rx);
    tx += Math.max(0, c.tx - p.tx);
  }
  return { rx: rx / dtSec, tx: tx / dtSec };
}
