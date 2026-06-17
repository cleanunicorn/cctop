// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Linux process source: reads the process table and interface counters from
// /proc. All read-only; spawns nothing. Module load is side-effect-free — the
// facade calls createLinuxSource() only on Linux, so this never touches /proc
// on the wrong OS.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { parseProcNetDev } from "./netdev.ts";
import type { Proc, ProcSource } from "./types.ts";

export function createLinuxSource(): ProcSource {
  const CLK_TCK = 100; // USER_HZ, fixed on every mainstream architecture

  const listAllProcesses = (): Proc[] => {
    const uptimeSec = Number.parseFloat(readFileSync("/proc/uptime", "utf8"));
    const bootSec = Date.now() / 1000 - uptimeSec;
    const procs: Proc[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        // /proc/pid/stat: "pid (comm) state ppid ..."; comm can contain
        // spaces, so split after the closing paren. After the split:
        // ppid is field 1, utime/stime 11/12, starttime (ticks) 19.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ppid = Number(f[1]);
        const cpuSec = (Number(f[11]) + Number(f[12])) / CLK_TCK;
        const startSec = bootSec + Number(f[19]) / CLK_TCK;

        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const rssKb = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0);

        let path: string | null = null;
        try {
          path = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
        } catch {} // not ours to inspect

        const argv0 = readFileSync(`/proc/${pid}/cmdline`, "latin1").split(
          "\0",
        )[0];
        const name =
          argv0?.split("/").pop() ||
          status.match(/^Name:\s+(.+)$/m)?.[1] ||
          "?";
        procs.push({
          pid,
          ppid,
          rss: rssKb * 1024,
          cpuSec,
          startSec,
          path,
          name,
        });
      } catch {} // process exited mid-scan
    }
    return procs;
  };

  const cwdOf = (pid: number): string | null => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  };

  // Snapshot the interface byte counters from /proc/net/dev (parseProcNetDev
  // does the parsing); a read failure signals null rather than a bogus zero.
  const netCounters = () => {
    try {
      return parseProcNetDev(readFileSync("/proc/net/dev", "utf8"));
    } catch {
      return null; // /proc/net/dev unreadable (unusual); signal failure
    }
  };

  return { listAllProcesses, cwdOf, netCounters };
}
