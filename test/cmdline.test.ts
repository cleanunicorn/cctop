// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/proc/cmdline.ts";

// parseCommand turns a process's argv into the name and subcommand the
// collectors identify it by. The subcommand is what tells a Claude Code session
// apart from one of the helper processes that share its name and executable.
describe("command line parsing (parseCommand)", () => {
  test("reads a plain executable path with no subcommand", () => {
    expect(parseCommand(["claude"])).toEqual({ name: "claude", sub: null });
    expect(parseCommand(["/usr/local/bin/claude"])).toEqual({
      name: "claude",
      sub: null,
    });
    expect(parseCommand([])).toEqual({ name: null, sub: null });
  });

  // the session Claude: version-named executable, flags, or a prompt — never a
  // subcommand a helper would carry
  test("keeps a session's argv free of a subcommand", () => {
    expect(
      parseCommand([
        "/u/.local/share/claude/versions/2.1.206",
        "--session-id",
        "abc",
      ]),
    ).toEqual({ name: "2.1.206", sub: null });
    expect(parseCommand(["claude", "-p", "summarize this"])).toEqual({
      name: "claude",
      sub: null,
    });
    // a path handed to claude is an argument, not a subcommand
    expect(parseCommand(["claude", "/tmp/prompt.md"])).toEqual({
      name: "claude",
      sub: null,
    });
  });

  // `claude daemon run` passes its subcommand the ordinary way, as argv[1]
  test("reads a subcommand passed as argv[1]", () => {
    expect(
      parseCommand([
        "/home/u/.local/bin/claude",
        "daemon",
        "run",
        "--json-path",
        "/home/u/.claude/daemon.json",
      ]),
    ).toEqual({ name: "claude", sub: "daemon" });
  });

  // The pty and spare hosts rewrite their process title instead: argv[0] is the
  // whole "claude bg-pty-host" string and argv[1] is a flag. Folded in like this
  // the subcommand is invisible to an argv[1] read, which is exactly how these
  // processes used to pass for sessions.
  test("reads a subcommand folded into a rewritten process title", () => {
    expect(
      parseCommand([
        "claude bg-pty-host",
        "--bg-pty-host",
        "/tmp/cc-daemon-1000/abc/pty/session.sock",
        "165",
        "72",
      ]),
    ).toEqual({ name: "claude", sub: "bg-pty-host" });
    expect(
      parseCommand([
        "claude bg-spare",
        "--bg-spare",
        "/tmp/cc-daemon-1000/abc/spare/claim.sock",
      ]),
    ).toEqual({ name: "claude", sub: "bg-spare" });
  });

  // The guard on the title split: an executable path can legitimately contain a
  // space (every macOS .app bundle with a space in its name), and splitting one
  // would strand the HOST column on "Visual". A path keeps its slashes; a
  // rewritten title has none before the space.
  test("does not mistake a spaced executable path for a title", () => {
    expect(
      parseCommand([
        "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      ]),
    ).toEqual({ name: "Electron", sub: null });
  });
});
