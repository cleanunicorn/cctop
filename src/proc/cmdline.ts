// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// argv reduced to the two fields the collectors identify a process by: the
// program name and its subcommand. Shared by both platform sources (Linux reads
// argv from /proc/<pid>/cmdline, macOS from KERN_PROCARGS2) and pure, so it is
// unit tested directly.

export interface Command {
  name: string | null; // argv[0]'s basename; null when argv is empty
  sub: string | null; // its subcommand, when it has one
}

// argv[0] is normally the executable's path, but a process may rewrite its
// title — and Claude Code's background helpers do, in a way that hides what they
// are. `claude daemon run` passes its subcommand as argv[1], while the pty and
// spare hosts fold theirs into the title: argv[0] is the whole string "claude
// bg-pty-host" and argv[1] is a flag. Both spellings have to surface the same
// subcommand, or the helpers read as sessions (see isClaudeProc).
//
// A rewritten title is told from a path by the slash: an executable path that
// happens to contain a space ("/Applications/Visual Studio Code.app/…") still
// has one in its first token, a title does not.
export function parseCommand(argv: string[]): Command {
  const argv0 = argv[0] ?? "";
  const space = argv0.indexOf(" ");
  const titled = space > 0 && !argv0.slice(0, space).includes("/");
  const cmd = titled ? argv0.slice(0, space) : argv0;
  const next = titled ? argv0.slice(space + 1).split(" ")[0] : argv[1];
  // a flag is not a subcommand, and neither is a path (`claude /tmp/prompt.md`)
  const sub =
    next && !next.startsWith("-") && !next.startsWith("/") ? next : null;
  return { name: cmd.split("/").pop() || null, sub };
}
