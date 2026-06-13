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

## Commands

Use the Makefile (thin wrappers over `package.json` scripts; `bun run <x>`
works too):

```sh
make deps       # bun install
make run        # run the TUI (make run ARGS="flux" to pass a filter)
make dev        # run with --watch live reload
make lint       # biome check --write . && tsc --noEmit   (format + lint + types)
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
                exports collectRows(filter), matchRow(), Row/SubProc/SubAgent types
src/render.ts   pure renderers over rows: buildFrame() (summary/header/groups),
                renderDetail(), rowKey(); the column table definition lives here
src/app.ts      interactive runtime: runApp(). AppState, raw-mode input loop,
                draw(), windowGroups(), the quit action
src/format.ts   formatting + ANSI helpers (visLen/pad/colors/formatMem/...)
```

Data flow: `proc.ts` + the session registry + transcripts → `collect.ts`
assembles `Row[]` → `render.ts` turns rows into ANSI lines → `cctop.ts` prints
them once, or `app.ts` drives them as a live, navigable TUI.

Data sources (all under `~/.claude`, read-only): the process table; the per-pid
session registry `sessions/<pid>.json`; and each session's transcript
`projects/<dir>/<id>.jsonl` (tail only, cached by mtime) plus sub-agent
transcripts under `<id>/subagents/`.

## Critical gotchas — read before editing

1. **Transcript reads MUST stay synchronous (`node:fs`), not `Bun.file`.**
   `collect.ts` reads transcripts with `openSync`/`readSync`/`fstatSync`. This
   is deliberate: Bun's async file I/O (`Bun.file().text()` / `.arrayBuffer()`)
   *stalls indefinitely* when the process holds the terminal in raw mode on the
   alternate screen — which the TUI does. Do not "modernize" these back to
   async; the first frame will hang forever. See the comment above
   `transcriptDetails()`.

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

- **Style is enforced by Biome** (`biome.json`): 2-space indent, double quotes,
  semicolons, trailing commas, ~80 col. Three rules are intentionally off —
  `noExplicitAny` (FFI/JSON parsing), `noControlCharactersInRegex` (the ANSI
  `\x1b` regex), `noNonNullAssertion`.
- **Types** are checked by `tsc --noEmit` (part of `make lint`). Keep it green.
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
