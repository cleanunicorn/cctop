// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Process table facade. Picks the platform implementation (macOS libproc FFI or
// Linux /proc) once at startup and re-exports its read-only surface plus the
// shared types and the pure /proc/net/dev parser. All read-only; spawns
// nothing.
//
// Both platform modules are imported statically: each is side-effect-free at
// load (the macOS dlopen and Linux /proc reads are deferred into its factory),
// so importing the wrong-OS module here is harmless — only the matching factory
// is ever called. This keeps the facade synchronous (no top-level await) and
// avoids dynamic-import specifiers that bun build --compile can't embed.

import { createDarwinSource } from "./proc/darwin.ts";
import { createLinuxSource } from "./proc/linux.ts";
import type { ProcSource } from "./proc/types.ts";

export { parseProcNetDev } from "./proc/netdev.ts";
export type { IfCounters, Proc, ProcSource } from "./proc/types.ts";

let source: ProcSource;
if (process.platform === "darwin") {
  source = createDarwinSource();
} else if (process.platform === "linux") {
  source = createLinuxSource();
} else {
  console.error(
    `error: unsupported platform: ${process.platform} (only macOS and Linux are supported)`,
  );
  process.exit(1);
}

// Re-export as closures, not the bound references directly: callers may capture
// these detached (collect/network.ts does makeNetSampler(netCounters)), and the
// indirection keeps that safe regardless of how the implementation is built.
export const listAllProcesses = (): ReturnType<
  ProcSource["listAllProcesses"]
> => source.listAllProcesses();
export const cwdOf = (pid: number): ReturnType<ProcSource["cwdOf"]> =>
  source.cwdOf(pid);
export const netCounters = (): ReturnType<ProcSource["netCounters"]> =>
  source.netCounters();
