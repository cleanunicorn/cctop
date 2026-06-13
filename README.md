# cctop

Interactive `top`-style monitor for Claude Code sessions.

`cctop` shows every Claude Code session running on your machine in one place:
its process stats, busy/idle state, context size, model, the app hosting it
(terminal or IDE), project, git branch, and last prompt — plus a tree of the
sub-processes (and live sub-agents) each session has spawned. Handy when you
have many sessions going at once across different shells and IDEs.

On a terminal it runs as a live TUI: navigate sessions with the keyboard, open
a per-session detail view, filter and sort on the fly, and quit a runaway
session without leaving the screen.

```
Sessions: ● 2 busy  ● 1 idle   ◆ 1 subagents
Resources: cpu 18.4%  mem 2.6G  procs 11

    PID   MEM    CPU   UP  S   CTX  MODEL     VER      HOST     PROJECT        BRANCH      LAST  PROMPT
▌ 95551  729M   8.7%   7h  ●  272k  opus-4-8  2.1.177  GoLand   cctop          main          3s  add a README
▌ 95564   88M   0.1%   7h  ├─ npm exec chrome-devtools-mcp@latest
▌ 91468   33M   2.1%   2s  └─ bash › go test ./...
  99877  556M   6.2%   4h  ●   60k  opus-4-8  2.1.177  Ghostty  flux-operator  rset-steps   12s  fix the controller
                          ◆ sonnet-4 · 24k ctx · Grep: func.*Reconcile
  40231  482M   0.0%   1h  ●   38k  sonnet-4  2.1.177  iTerm    podinfo        main          4m  review the open PR

cctop/v0.0.1 · every 2s · 14:22:07  ·  ↑↓ move · enter detail · / filter · s sort · x quit · ? help · q exit
```

(The selected session is marked with a `▌` bar. Busy sessions are green, idle
red; CPU and context warm toward red as they climb.)

## Requirements

- [Bun](https://bun.sh) 1.x
- macOS or Linux

## Usage

```sh
git clone https://github.com/stefanprodan/cctop.git
cd cctop
bun cctop.ts
```

On an interactive terminal it runs as a live TUI (like `top`); when piped,
redirected, or run with `--once` it prints a single frame and exits, so
`cctop --json | jq` and `cctop | grep` keep working.

To run it from anywhere, make it executable and link it onto your `PATH`:

```sh
chmod +x cctop.ts
ln -sf "$PWD/cctop.ts" ~/.local/bin/cctop
```

### Keys

While the TUI is running:

| Key             | Action                                              |
|-----------------|-----------------------------------------------------|
| `↑`/`k` `↓`/`j` | move the selection                                  |
| `PgUp`/`PgDn`   | jump 10 rows                                        |
| `g` / `G`       | jump to top / bottom                                |
| `enter`         | open the detail view for the selected session       |
| `esc`           | leave the detail view / close an overlay            |
| `/`             | filter sessions (type, `enter` to apply)            |
| `s`             | cycle the sort column (default, cpu, mem, ctx)      |
| `x`             | quit the selected session (`SIGTERM`, with confirm) |
| `i`             | interrupt the selected session (`SIGINT`, confirm)  |
| `?`             | toggle the help overlay                             |
| `q` / `Ctrl-C`  | quit cctop                                          |

### Options

```
cctop [filter] [options]

  filter                 only show sessions whose project, host, branch,
                         model, or session id contains this
  -w, --watch[=seconds]  set the refresh interval (default: 2s)
  --once                 render once and exit (default when piped)
  --json                 print full session details as JSON
  -v, --version          show version
  -h, --help             show this help
```

Examples:

```sh
cctop flux-operator   # start filtered to sessions matching "flux-operator"
cctop --watch=1       # refresh every second
cctop --once          # single frame, then exit
cctop --json          # machine-readable snapshot
```

## How it works

Everything is read locally and `cctop` spawns no processes of its own; the only
thing it ever does to another process is send a signal — and only when you
explicitly quit (`x`, `SIGTERM`) or interrupt (`i`, `SIGINT`) a session. It
correlates three sources:

1. **The process table** — via macOS `libproc` (`bun:ffi`) or Linux `/proc`,
   for PIDs, memory, CPU, uptime, and the parent/child tree.
2. **`~/.claude/sessions/<pid>.json`** — the registry Claude Code keeps per
   running session (session id, busy/idle status, cwd, version, name).
3. **The session transcript** (`~/.claude/projects/<dir>/<id>.jsonl`) — only
   the tail is read, for the model, context tokens, git branch, and last
   prompt; results are cached by mtime so idle sessions aren't re-scanned.

The `HOST` column is resolved by walking each session's process ancestry past
shells and wrappers to the first app bundle or recognizable program (iTerm,
Ghostty, VS Code, a JetBrains IDE, tmux, sshd…). Sub-process rows skip a tool's
wrapping shell so the real command shows (`bash › go test`). Live sub-agents
(`Task` / `Workflow`) run in-process so they never hit the process table; they
appear as `◆` rows read from the transcripts each session writes under its
`subagents/` directory.

Transcript tails are read with synchronous `fs` I/O on purpose: Bun's async file
reads can stall while the process holds the terminal in raw mode on the
alternate screen, which is exactly what the live TUI does.

## Project layout

```
cctop.ts        entry: CLI parsing and the non-interactive (--once/--json) paths
src/proc.ts     process table (macOS libproc FFI / Linux /proc)
src/collect.ts  session discovery, transcript + sub-agent parsing, collectRows()
src/render.ts   the table, tree, and detail-view renderers
src/app.ts      the interactive TUI runtime (input loop, state, actions)
src/format.ts   formatting and ANSI helpers
```

## License

[Apache 2.0](LICENSE)
