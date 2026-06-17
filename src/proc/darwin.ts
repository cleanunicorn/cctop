// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// macOS process source: reads the process table via libproc (bun:ffi) and the
// interface counters via getifaddrs. All read-only; spawns nothing. Importing
// bun:ffi is safe on any OS — it's a Bun builtin — but dlopen of the macOS
// dylibs would throw elsewhere, so every eager FFI call (dlopen, the timebase
// query) lives inside createDarwinSource(); the facade calls it only on darwin.

import { CString, dlopen, FFIType, ptr, read } from "bun:ffi";
import type { IfCounters, Proc, ProcSource } from "./types.ts";

export function createDarwinSource(): ProcSource {
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
    // getifaddrs(struct ifaddrs **) allocates a linked list of interface
    // records; freeifaddrs releases it. Read-only snapshot of kernel counters.
    getifaddrs: { args: [FFIType.ptr], returns: FFIType.i32 },
    freeifaddrs: { args: [FFIType.ptr], returns: FFIType.void },
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
  const cwdOf = (pid: number): string | null => {
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

  // struct ifaddrs (LP64): ifa_next@0, ifa_name@8, ifa_flags@16, ifa_addr@24,
  // ifa_netmask@32, ifa_dstaddr@40, ifa_data@48 (pointers are 8 bytes). For an
  // AF_LINK (18) record ifa_data points at a struct if_data whose byte counters
  // sit at ifi_ibytes@40 / ifi_obytes@44 (8 u_char + 8 u32 precede them).
  //
  // Those counters are 32-bit and wrap at 4 GiB. macOS has no read-only 64-bit
  // alternative: NET_RT_IFLIST2's `if_data64` leaves the high 32 bits of the
  // byte counters zeroed (verified empirically — the 64-bit total `netstat`
  // shows is reconstructed elsewhere), so it is no better. We therefore return
  // the raw 32-bit counters per interface and let the rate sampler clamp each
  // interface's wrap on its own (see collect/network.ts).
  const AF_LINK = 18;
  const IFF_LOOPBACK = 0x8; // ifa_flags bit; skip lo by flag, not by name
  // Bun types pointers as an opaque brand, but at runtime they are plain
  // numbers; retype read/free/CString to thread numbers through the list walk.
  const rd = read as unknown as {
    ptr: (p: number, o: number) => number;
    u8: (p: number, o: number) => number;
    u32: (p: number, o: number) => number;
  };
  const mkCStr = CString as unknown as new (p: number) => string;
  const free = libc.symbols.freeifaddrs as unknown as (p: number) => void;
  const netCounters = () => {
    const head = new BigUint64Array(1);
    if (libc.symbols.getifaddrs(ptr(head)) !== 0) return null;
    const list = Number(head[0]);
    const out: IfCounters[] = [];
    // freeifaddrs must run even if a read throws mid-walk, or the kernel
    // allocation leaks on every refresh
    try {
      for (let cur = list; cur !== 0; cur = rd.ptr(cur, 0)) {
        const addr = rd.ptr(cur, 24);
        if (addr === 0 || rd.u8(addr, 1) !== AF_LINK) continue;
        if (rd.u32(cur, 16) & IFF_LOOPBACK) continue; // loopback, by flag
        const data = rd.ptr(cur, 48);
        if (data === 0) continue;
        out.push({
          name: String(new mkCStr(rd.ptr(cur, 8))),
          rx: rd.u32(data, 40),
          tx: rd.u32(data, 44),
        });
      }
    } catch {
      // a recoverable read error (e.g. CString over an unexpected address) must
      // signal failure, not crash — the refresh loop has no catch around this
      return null;
    } finally {
      if (list !== 0) free(list); // runs even on the catch's early return
    }
    return out;
  };

  const listAllProcesses = (): Proc[] => {
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

  return { listAllProcesses, cwdOf, netCounters };
}
