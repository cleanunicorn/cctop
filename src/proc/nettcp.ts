// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Pure parser for the Linux /proc/net/tcp and /proc/net/tcp6 formats. A leaf
// module (no I/O, no FFI) so it can be unit-tested directly without loading a
// platform's process source; linux.ts supplies the file contents.

// Parse one /proc/net/tcp[6] file into [inode, port] pairs for LISTEN sockets.
// Format: a one-line header, then one row per socket:
//   "sl local_address rem_address st ... retrnsmt uid timeout inode ...".
// After splitting the trimmed row on whitespace, local_address is field 1
// ("HEXIP:HEXPORT"), the connection state is field 3 ("0A" = TCP_LISTEN), and
// the socket inode is field 9 (the tx/rx-queue and tr/when fields are
// colon-joined single tokens, which is why inode lands at 9). A :0000 port is
// dropped. tcp6 carries a longer hex address but the same colon-split layout,
// so the field indices are identical.
export function parseTcpListen(text: string): [string, number][] {
  const out: [string, number][] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue; // 0A = TCP_LISTEN
    const port = Number.parseInt(f[1].split(":")[1], 16);
    if (port) out.push([f[9], port]);
  }
  return out;
}
