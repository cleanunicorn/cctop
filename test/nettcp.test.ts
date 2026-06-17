// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseTcpListen } from "../src/proc/nettcp.ts";

// A realistic /proc/net/tcp body: header line, then sockets. Row 0 and 1 are
// LISTEN (st "0A"); row 2 is ESTABLISHED (st "01"); row 3 is a LISTEN with a
// :0000 port. Inode is the 10th whitespace field.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 67890 1 0000000000000000 100 0 0 10 0
   2: 0100007F:C1B2 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   3: 0100007F:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0
`;

// /proc/net/tcp6 carries a 32-char hex address but the same colon-split layout.
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000000 100 0 0 10 0
`;

describe("parseTcpListen", () => {
  test("keeps only LISTEN sockets with a non-zero port, mapping inode->port", () => {
    expect(parseTcpListen(TCP)).toEqual([
      ["12345", 8080], // 0x1F90
      ["67890", 80], // 0x0050
    ]);
  });

  test("parses the longer tcp6 address with the same field indices", () => {
    expect(parseTcpListen(TCP6)).toEqual([["99999", 5432]]); // 0x1538
  });

  test("returns nothing for a header-only or empty file", () => {
    expect(parseTcpListen("  sl  local_address ...\n")).toEqual([]);
    expect(parseTcpListen("")).toEqual([]);
  });
});
