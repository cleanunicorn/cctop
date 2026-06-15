# AGENTS.md

Guidance for AI agents and contributors working on **cctop**, an interactive
`top`-style TUI for monitoring running Claude Code sessions.

## What this is

A single Bun/TypeScript program that lists every running Claude Code session
with process stats, busy/idle state, context size, model, host app, project,
branch, last prompt, a tree of sub-processes, and live sub-agents. On a TTY it's
an interactive TUI; piped or with `--once`/`--json` it prints one frame.

- **Runtime:** Bun (TypeScript run directly, no build step for dev).
- **Platforms:** macOS and Linux only (process table is read via macOS
  `libproc` FFI or Linux `/proc`).
- **Everything is read-only.** cctop spawns no processes. The *only* thing it
  ever does to another process is send a signal — and only on an explicit user
  action (`x` → SIGTERM). Preserve this property.
- **Zero runtime dependencies.** cctop imports only Bun and OS built-ins
  (`bun:ffi`, `node:fs`, …); `package.json` has an empty `dependencies` (the
  devDependencies are just Biome/tsc/types). Do not add npm packages — keep it
  dependency-free.

## Bun docs MCP server

This repo ships a project-scoped MCP server in `.mcp.json`.
Use the `bun-docs` MCP to look up Bun APIs and behavior instead of guessing.
It exposes `search_bun` (semantic search) and
`query_docs_filesystem_bun` (`rg`/`cat`/`head` over the docs).

## Commands

Use the Makefile (thin wrappers over `package.json` scripts; `bun run <x>`
works too):

```sh
make deps       # bun install
make run        # run the TUI (make run ARGS="flux" to pass a filter)
make dev        # run with --watch live reload
make lint       # bun biome check --write . && bun tsc --noEmit  (format + lint + types)
make build      # compile a standalone binary into bin/
make clean      # remove bin/ and stray .bun-build files
make update     # bun update (within semver ranges)
make install    # compile + install onto PATH (override PREFIX=...)
```

**Always run `make lint` before finishing a change.** It formats, lints, and
type-checks; it exits non-zero (and prints why) on any unfixable issue.

## Layout

```
cctop.ts        entry: CLI arg parsing, non-interactive paths (--once/--json/-h/-v),
                dispatch to runApp(); VERSION derived from package.json
src/proc.ts     process table: macOS libproc FFI / Linux /proc.
                exports listAllProcesses(), cwdOf()
src/collect.ts  session discovery + transcript/sub-agent parsing.
                exports collectRows(filter), matchRow(), Instance/SubProc/SubAgent types
src/render.ts   pure renderers over rows: buildFrame() (summary/header/groups),
                renderDetail(), rowKey(); the column table definition lives here
src/app.ts      interactive runtime: runApp(). AppState, raw-mode input loop,
                draw(), windowGroups(), the quit action
src/format.ts   formatting + ANSI helpers (visLen/pad/colors/formatMem/...)
```

Data flow: `proc.ts` + the session registry + transcripts → `collect.ts`
assembles `Instance[]` → `render.ts` turns rows into ANSI lines → `cctop.ts` prints
them once, or `app.ts` drives them as a live, navigable TUI.

Data sources (all under `~/.claude`, read-only): the process table; the per-pid
session registry `sessions/<pid>.json`; and each session's transcript
`projects/<dir>/<id>.jsonl` (tail only, cached by mtime) plus sub-agent
transcripts under `<id>/subagents/`.

The `HOST` column is resolved by walking each session's process ancestry past
shells and wrappers to the first app bundle or recognizable program (iTerm,
Ghostty, VS Code, a JetBrains IDE, tmux, sshd…); see `HOST_SKIP` in `collect.ts`.
Sub-process rows skip a tool's wrapping shell so the real command shows
(`bash › go test`). A Claude session spawned by another Claude (a background job
or sub-session) is the exception: it gets its own top-level row rather than
appearing as a sub-process of its parent, and its `HOST` reads `claude` (the
parent) instead of the nested process's versioned exec name (`2.1.177`) — both
keyed off the same `isClaudeProc` check. Live sub-agents (`Task`/`Workflow`) run
in-process, so they never hit the process table — they are read from the
`subagents/` transcripts.

## Critical gotchas — read before editing

1. **File *contents* go through `Bun.file` async (`.json()`,
   `.slice().bytes()`, `Bun.write()`); `node:fs` is only for directory and
   metadata ops (`readdirSync`/`statSync`/`mkdirSync`/`renameSync`).** The async
   reads are deliberate: `collectRows` overlaps every session's transcript and
   registry/usage JSON reads with `Promise.all`, so the whole scan runs
   concurrently. Keep it that way. The `node:fs` calls (directory listing,
   mtime/birthtime, and the `--capture-usage` mkdir + atomic temp-file rename)
   stay synchronous — they have no `Bun.file` equivalent.

2. **Non-interactive parity is a contract.** `--once`, `--json`, and piped
   output (`isTTY` false) must keep producing a single plain frame and exit, so
   `cctop --json | jq` and `cctop | grep` work. Only an interactive TTY runs
   `runApp()`. Don't move TUI-only escape sequences into the shared path.

3. **stdin delivers batches.** A single `data` event can carry several
   keypresses (fast typing, or input buffered during startup) and multi-byte
   escape sequences. `app.ts` `parseKeys()` splits a chunk into individual logical
   keys (keeping CSI/SS3 sequences whole). Route all key handling through it;
   never treat a chunk as one key. Note the PTY translates Enter `\r`→`\n`.

4. **Selection is tracked by a stable key, not a row index.** Rows re-sort every
   refresh, so the cursor is keyed on `rowKey(r)` = `sessionId ?? pid`
   (`reconcile()` clamps when a session disappears). Keep this invariant.

5. **`bun build --compile` leaks a `.bun-build` temp file** (upstream bug
   oven-sh/bun#14020). The `build` script removes it (`rm -f .*.bun-build`) and
   it's gitignored. Keep that cleanup if you touch the build command.

6. **Actions are guarded.** Only act on real session rows (they have a pid);
   never sub-process/sub-agent rows. `process.kill` errors (ESRCH/EPERM) must go
   to the status line, never crash. Quitting is confirm-gated.

## Conventions

- **Bun-only toolchain.** Bun is assumed to be the *only* runtime present — no Node.
- **Style is enforced by Biome** (`biome.json`): 2-space indent, double quotes,
  semicolons, trailing commas, ~80 col. Three rules are intentionally off —
  `noExplicitAny` (FFI/JSON parsing), `noControlCharactersInRegex` (the ANSI
  `\x1b` regex), `noNonNullAssertion`.
- **Types** are checked by `bun tsc --noEmit` (part of `make lint`). Keep it green.
- **Comments explain *why*, not *what*** — match the existing density. The FFI
  struct offsets and the sync-I/O rationale are load-bearing comments; keep them.
- **Version is single-sourced** in `package.json`; `cctop.ts` derives
  `VERSION = `v${pkg.version}``. Bump via `bun pm version` (no `v` in the field).
- Keep `render.ts` pure (rows → strings). Interactive state, scrolling, and
  selection live in `app.ts`.

## Verifying changes

- **Non-interactive / regressions:** `bun cctop.ts --once`, `--json`,
  `bun cctop.ts | cat` (single frame), `-h`, `-v`.
- **The TUI needs a real PTY** (it requires `isTTY`; piping disables it). Drive
  it with `expect`, e.g. spawn `bun cctop.ts`, sleep, send keys, then quit with
  `q` (not Ctrl-C — `\x03` kills Bun before buffered stdin flushes, so keys are
  lost). The last drawn frame before `q` reflects the final state; quitting draws
  nothing.
- **Testing the quit action safely:** don't kill real sessions. Back a fake
  registry entry (`~/.claude/sessions/<pid>.json` with `startedAt` ≈ now) with a
  throwaway `sleep 600 &` process, filter to it, `x` → `y`, and confirm the
  sleep process got the signal. Clean up the json + process afterward.

## Spinning up live sub-agents on demand for testing

To exercise the sub-agent rows (the cyan `◆` lines with model, context, and a
ticking *last action*), park a handful of throwaway agents under the current
Claude Code session. Each one blocks on foreground shell loops, so it stays
alive and visibly active for ~10 minutes at near-zero token cost after startup,
and you can stop any of them on demand.

Launch **5 background agents on Haiku**, each with a name so they're easy to
tell apart in the tree and to stop individually — `alpha`, `bravo`, `charlie`,
`delta`, `echo`. Give each the same instruction (swap the name):

> You will make SEVEN Bash tool calls, ONE AT A TIME, in the **foreground** (do
> NOT set `run_in_background`), and nothing else. Don't touch any files. After
> each call returns, immediately make the next one. Each call (rounds 1–7) runs
> this with `timeout: 120000`, swapping the round number R:
> `for i in $(seq 1 90); do echo "alpha round R $i"; sleep 1; done`
> Each loop runs ~90 seconds — that's intended; wait for it, then fire the next
> round. After the 7th call returns, reply with the single word: done

Key points:

- **Several short calls, NOT one long one — this is load-bearing.** A sub-agent
  has no process of its own; cctop infers liveness purely from its transcript's
  mtime (`liveSubagents()` in `collect.ts`). A *single* 10-minute foreground
  call writes one turn and then goes silent on disk, so the row vanishes after
  `SUBAGENT_BUSY_MS` (3 min) even though the loop is still running. Each *new*
  Bash call writes a fresh `tool_use` turn, bumping the mtime back inside the
  window — so ~90s rounds (well under 3 min) keep the `◆` row visible the whole
  time, and you watch the label tick `round 1` → `round 2` → …
- **The loop is load-bearing too.** A bare `sleep 90` is hard-blocked by the
  harness (a standalone leading sleep is refused even with the sandbox off). A
  `sleep` *inside* a loop that does real work (`echo`) is allowed — that's what
  keeps the agent parked instead of exiting immediately. Don't "simplify" it
  back to a plain sleep.
- **Foreground, not background.** `run_in_background: true` makes the agent fire
  the command and exit right away (it won't stay visible). The agent must *block*
  on each call, so it runs in the foreground; the distinct echo per second drives
  the live last-action display. `120000` (2 min) comfortably covers a 90s loop.
- **Cost.** Each agent spends its ~12k-token startup plus a cheap Haiku turn per
  round (7 rounds), then ≈0 while parked inside each loop.
- **Stop them** with `TaskStop` by task id (all at once, or a subset by name);
  otherwise they exit themselves after the 7th round (~10–11 min).
