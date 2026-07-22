// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Facts about the file cctop is running from. Local and read-only (two stat
// calls) — no network, no subprocess — so the monitor may import this freely;
// the network half of self-updating lives in ./upgrade.ts, which the refresh
// loop never touches.

import { realpathSync, statSync } from "node:fs";

// A compiled standalone binary runs *as itself*, so process.execPath is the
// cctop program; a source or `bun install -g` run executes under the bun
// interpreter, so execPath is the bun runtime. Newer Bun exposes
// Bun.isStandaloneExecutable directly — trust it when present, fall back to the
// execPath heuristic on older runtimes (it is undefined before ~1.3.x).
export function isCompiledBinary(): boolean {
  const flag = (Bun as { isStandaloneExecutable?: boolean })
    .isStandaloneExecutable;
  if (typeof flag === "boolean") return flag;
  return !/[/\\]bun(-debug)?(\.exe)?$/i.test(process.execPath);
}

// Identity of a file: inode, mtime, size. Two different stamps mean the path no
// longer names the bytes it used to. realpath() first so a symlinked install
// (Homebrew) stamps the target, not the link. Returns null when the path can't
// be read — a deleted or unreadable file is "unknown", never "changed".
export function fileStamp(path: string): string | null {
  try {
    const st = statSync(realpathSync(path));
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

// Stamp the binary this process was launched from, or null when there is no
// single file to watch: running from source or under `bun install -g`, execPath
// is the bun runtime, and upgrading *bun* is not upgrading cctop.
export function selfStamp(): string | null {
  return isCompiledBinary() ? fileStamp(process.execPath) : null;
}
