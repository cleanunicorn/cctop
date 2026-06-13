// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Process table access: macOS via libproc (bun:ffi) or Linux via /proc.
// All read-only; spawns nothing. Exposes listAllProcesses() and cwdOf().

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface Proc {
  pid: number;
  ppid: number;
  rss: number; // resident memory, bytes
  cpuSec: number; // total CPU time consumed, seconds
  startSec: number; // process start, unix seconds
  path: string | null; // executable path
  name: string; // argv[0] basename or best-effort
}

// assigned in the platform block below; the fallback at the bottom exits if
// neither matched, so by use it is always set.
export let listAllProcesses!: () => Proc[];
export let cwdOf: (pid: number) => string | null = () => null;

// --- Process listing: macOS (libproc FFI) ---------------------------------

if (process.platform === "darwin") {
  const { dlopen, ptr, FFIType } = await import("bun:ffi");

  const PROC_PIDTBSDINFO = 3; // struct proc_bsdinfo, 136 bytes
  const PROC_PIDTASKINFO = 4; // struct proc_taskinfo, 96 bytes
  const PROC_PIDVNODEPATHINFO = 9; // struct proc_vnodepathinfo, 2352 bytes
  const PROC_PIDT_SHORTBSDINFO = 13; // struct proc_bsdshortinfo, 64 bytes
  const CTL_KERN = 1;
  const KERN_PROCARGS2 = 49;

  const libproc = dlopen("/usr/lib/libproc.dylib", {
    proc_listallpids: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_pidpath: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    proc_name: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });

  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: {
      args: [
        FFIType.ptr, // int *name
        FFIType.u32, // u_int namelen
        FFIType.ptr, // void *oldp
        FFIType.ptr, // size_t *oldlenp
        FFIType.ptr, // void *newp
        FFIType.u64, // size_t newlen
      ],
      returns: FFIType.i32,
    },
    mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
  });

  // task CPU times are in mach time units, not nanoseconds
  const machTimebase = new Uint32Array(2); // { numer, denom }
  libc.symbols.mach_timebase_info(ptr(machTimebase));
  const machToSec = machTimebase[0] / machTimebase[1] / 1e9;

  // argv[0] is how the process was invoked; the claude CLI shows up as
  // "claude" here while its executable is named after its version.
  // Layout of KERN_PROCARGS2: argc (i32), exec path, NUL padding, argv.
  const argsBuf = new Uint8Array(8192);
  const procArgv0 = (pid: number): string | null => {
    const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
    const size = new BigUint64Array([BigInt(argsBuf.byteLength)]);
    const r = libc.symbols.sysctl(
      ptr(mib),
      3,
      ptr(argsBuf),
      ptr(size),
      null,
      0n,
    );
    if (r !== 0) return null;
    // latin1: each byte maps 1:1 to a char, which is all we need to find the
    // NUL-separated argv fields (Buffer avoids TextDecoder's stricter typing)
    const raw = Buffer.from(argsBuf.slice(4, Number(size[0]))).toString(
      "latin1",
    );
    const start = raw.indexOf("\0");
    if (start < 0) return null;
    const argv0 = raw.slice(start).replace(/^\0+/, "");
    const end = argv0.indexOf("\0");
    if (end < 0) return null;
    return argv0.slice(0, end) || null;
  };

  // proc_vnodepathinfo: pvi_cdir.vip_path sits after the 152-byte
  // vnode_info, so the cwd is the NUL-terminated string at offset 152
  const vnodeInfo = new Uint8Array(2352);
  cwdOf = (pid) => {
    const got = libproc.symbols.proc_pidinfo(
      pid,
      PROC_PIDVNODEPATHINFO,
      0n,
      ptr(vnodeInfo),
      vnodeInfo.byteLength,
    );
    if (got < 160) return null;
    const end = vnodeInfo.indexOf(0, 152);
    return end > 152
      ? new TextDecoder().decode(vnodeInfo.slice(152, end))
      : null;
  };

  listAllProcesses = () => {
    const pids = new Int32Array(16384);
    const n = libproc.symbols.proc_listallpids(ptr(pids), pids.byteLength);

    const taskInfo = new Uint8Array(96);
    const taskView = new DataView(taskInfo.buffer);
    const bsdInfo = new Uint8Array(136);
    const bsdView = new DataView(bsdInfo.buffer);
    const shortInfo = new Uint8Array(64);
    const shortView = new DataView(shortInfo.buffer);
    const cstr = new Uint8Array(4096);
    const readCstr = (len: number) =>
      len > 0 ? new TextDecoder().decode(cstr.slice(0, len)) : null;

    const procs: Proc[] = [];
    for (let i = 0; i < n; i++) {
      const pid = pids[i];
      if (pid <= 0) continue;
      // taskinfo fails for other users' processes; keep them anyway
      // (rss/cpu zeroed) so the host-app ancestry walk still works
      let rss = 0;
      let cpuSec = 0;
      const got = libproc.symbols.proc_pidinfo(
        pid,
        PROC_PIDTASKINFO,
        0n,
        ptr(taskInfo),
        taskInfo.byteLength,
      );
      if (got >= 96) {
        rss = Number(taskView.getBigUint64(8, true)); // pti_resident_size
        cpuSec = // pti_total_user + pti_total_system
          (Number(taskView.getBigUint64(16, true)) +
            Number(taskView.getBigUint64(24, true))) *
          machToSec;
      }

      // pbi_ppid at offset 16, pbi_start_tvsec at offset 120
      let ppid = 0;
      let startSec = 0;
      let comm: string | null = null;
      const gotBsd = libproc.symbols.proc_pidinfo(
        pid,
        PROC_PIDTBSDINFO,
        0n,
        ptr(bsdInfo),
        bsdInfo.byteLength,
      );
      if (gotBsd >= 128) {
        ppid = bsdView.getUint32(16, true);
        startSec = Number(bsdView.getBigUint64(120, true));
      } else if (
        // bsdinfo fails for other users' processes (login, launchd...),
        // but the host-app ancestry walk still needs their ppid; the
        // short variant works for any process: ppid at 4, comm at 16
        libproc.symbols.proc_pidinfo(
          pid,
          PROC_PIDT_SHORTBSDINFO,
          0n,
          ptr(shortInfo),
          shortInfo.byteLength,
        ) >= 64
      ) {
        ppid = shortView.getUint32(4, true);
        const end = shortInfo.indexOf(0, 16);
        comm =
          new TextDecoder().decode(
            shortInfo.slice(16, end < 16 || end > 32 ? 32 : end),
          ) || null;
      }

      const path = readCstr(
        libproc.symbols.proc_pidpath(pid, ptr(cstr), cstr.byteLength),
      );
      const name =
        procArgv0(pid)?.split("/").pop() ??
        readCstr(libproc.symbols.proc_name(pid, ptr(cstr), cstr.byteLength)) ??
        comm ??
        path?.split("/").pop() ??
        "?";
      procs.push({ pid, ppid, rss, cpuSec, startSec, path, name });
    }
    return procs;
  };
}

// --- Process listing: Linux (/proc) ----------------------------------------

if (process.platform === "linux") {
  const CLK_TCK = 100; // USER_HZ, fixed on every mainstream architecture

  listAllProcesses = () => {
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

  cwdOf = (pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  };
}

if (!listAllProcesses) {
  console.error(
    `error: unsupported platform: ${process.platform} (only macOS and Linux are supported)`,
  );
  process.exit(1);
}
