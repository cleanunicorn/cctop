# Contributing to cctop

Thanks for helping improve cctop! It's a single Bun/TypeScript program with no
build step and zero runtime dependencies. This guide covers local setup; see
[AGENTS.md](../AGENTS.md) for the architecture, conventions, and invariants.

## Prerequisites

cctop runs on [Bun](https://bun.sh); formatting and linting use
[Biome](https://biomejs.dev), and type-checking uses the TypeScript compiler
(`tsc`). On macOS, install them with [Homebrew](https://brew.sh):

```sh
brew install bun biome typescript
```

Bun is the only hard requirement — Biome and TypeScript are also listed as
devDependencies, so `make deps` (`bun install`) pulls them in as well.

## Getting started

```sh
git clone https://github.com/stefanprodan/cctop.git
cd cctop
make deps        # bun install
```

## Development

Run the TUI with live reload — Bun restarts it whenever you edit `cctop.ts` or
anything under `src/`:

```sh
make dev                 # bun --watch cctop.ts
make dev ARGS="flux"     # pass a filter
```

Other useful targets:

```sh
make run         # run once, without the file watcher
make lint        # Biome format + lint, then tsc --noEmit
make build       # compile a standalone binary into bin/
```

Always run `make lint` before opening a pull request — it formats, lints, and
type-checks, and must pass.

## Using Claude Code

The guidance for AI agents lives in [AGENTS.md](../AGENTS.md). Rather than add a
`CLAUDE.md`, you can have Claude Code load it automatically with a `SessionStart`
hook: on each session it checks for an `AGENTS.md` at the repo root (and no
`CLAUDE.md`) and tells Claude to read it.

Add this to your Claude Code settings — `~/.claude/settings.json` to cover all
your repos, or `.claude/settings.json` for just this one (requires `jq`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "root=$(git rev-parse --show-toplevel 2>/dev/null || pwd); if [ -f \"$root/AGENTS.md\" ] && [ ! -f \"$root/CLAUDE.md\" ]; then jq -n '{hookSpecificOutput:{hookEventName:\"SessionStart\",additionalContext:\"Read AGENTS.md at the repository root in full now, and follow it for the rest of the session.\"}}'; fi 2>/dev/null || true",
            "statusMessage": "Loading AGENTS.md"
          }
        ]
      }
    ]
  }
}
```

With this in place, every Claude Code session in a repo that has an `AGENTS.md`
picks up its architecture, conventions, and the read-only / zero-dependency
rules — no per-repo `CLAUDE.md` needed.
