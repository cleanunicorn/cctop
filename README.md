# cctop

Interactive `top`-style monitor for Claude Code sessions. Know at a glance what
Claude is working on, how much context it has left, and which sessions are
waiting for input.

<p align="center">
  <img src="docs/screens/cctop-tui.png" alt="cctop">
</p>

## Features

- **All your sessions at a glance** — every running Claude Code session in one
  table: process stats (PID, memory, CPU, uptime), busy/idle state, context
  size, model, host app (terminal or IDE), project, git branch, and last prompt.
- **Process & sub-agent tree** — each session's sub-processes and live
  sub-agents are listed beneath it.
- **Live TUI** — navigate with the keyboard, open a per-session detail view, and
  filter and sort on the fly; piped or run with `--once`/`--json` it prints a
  single frame, so `cctop --json | jq` works.
- **Status at a glance** — busy sessions are green, idle red; CPU and context
  heat toward red as they climb; the selected session is marked with a blue bar.
- **Weekly usage limits** *(opt-in)* — show your Claude subscription's 5h/7d
  rate-limit usage in the summary line.
- **Quit a runaway session** in place (`x` → `SIGTERM`, with confirm).
- **Read-only and local** — reads only `~/.claude` and the process table, spawns
  no processes, and only ever signals one when you explicitly quit it.
- **Zero dependencies** — a single Bun/TypeScript program with no npm packages;
  it uses only Bun and OS built-ins.

## Requirements

- [Bun](https://bun.sh) 1.x
- macOS or Linux

## Install

Install `cctop` globally with:

```sh
bun install -g github:stefanprodan/cctop
```

This puts a `cctop` command in `~/.bun/bin` (add it to your `PATH` with `export PATH="$HOME/.bun/bin:$PATH"`).

Prefer not to install Bun? Each [release](https://github.com/stefanprodan/cctop/releases)
ships standalone binaries for macOS and Linux (`amd64`/`arm64`) with Bun bundled
in — no runtime needed. Download cctop and install with:

```sh
# macOS arm64 — swap darwin_arm64 for darwin_amd64 / linux_amd64 / linux_arm64
curl -fsSL https://github.com/stefanprodan/cctop/releases/latest/download/cctop_darwin_arm64.tar.gz | tar xz
install -m 0755 cctop /usr/local/bin/cctop
```

You can now run it with `cctop` in your terminal.

### Update

Pull the latest version with:

```sh
bun install -g github:stefanprodan/cctop --force
```

### Uninstall

```sh
bun uninstall -g cctop
```

## Weekly usage limits

cctop can show your Claude subscription's rate-limit usage in the summary line:

```
Limits: 8% 7d (2d9h left)  60% 5h (2h32m left)
```

This is opt-in and needs a one-time status-line script (the limits aren't stored
on disk otherwise). See [docs/usage-limits.md](docs/usage-limits.md) for the
two-step setup; the tap is below.

<details>
<summary>Status-line tap (add to your <code>statusLine</code> script, needs <code>jq</code>)</summary>

```bash
input=$(cat)

# cctop usage tap: persist the account-wide 5h/7d rate limits in cctop/usage.json
# docs: https://github.com/stefanprodan/cctop/blob/main/docs/usage-limits.md
{
  cctop_dir="$HOME/.claude/cctop"; cctop_f="$cctop_dir/usage.json"
  cctop_now=$(date +%s)
  cctop_mt=$(stat -f %m "$cctop_f" 2>/dev/null || stat -c %Y "$cctop_f" 2>/dev/null || echo 0)
  if [ $(( cctop_now - cctop_mt )) -ge 30 ]; then
    cctop_snap=$(echo "$input" \
      | jq -c '.rate_limits | objects | select(length > 0)
               | {rate_limits: ., captured_at: (now|floor)}' 2>/dev/null)
    if [ -n "$cctop_snap" ]; then
      mkdir -p "$cctop_dir"
      cctop_tmp=$(mktemp "$cctop_dir/usage.json.XXXXXX") \
        && printf '%s' "$cctop_snap" > "$cctop_tmp" \
        && mv -f "$cctop_tmp" "$cctop_f"
    fi
  fi
} || true
```

</details>

## Usage

On an interactive terminal `cctop` runs as a live TUI (like `top`); when piped,
redirected, or run with `--once` it prints a single frame and exits.

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
| `s`             | cycle the sort column (default, cpu, mem, ctx, pid) |
| `x`             | quit the selected session (`SIGTERM`, with confirm) |
| `?`             | toggle the help overlay                             |
| `q` / `Ctrl-C`  | quit cctop                                          |

### Options

```
cctop [filter] [options]

  filter                 only show sessions whose project, host, branch,
                         model, or session id contains this
  -w, --watch[=seconds]  set the refresh interval (default: 1s, min 0.25s)
  --once                 render once and exit (default when piped)
  --json                 print full session details as JSON
  -v, --version          show version
  -h, --help             show this help
```

Examples:

```sh
cctop flux         # start filtered to sessions matching "flux"
cctop --watch=0.5  # refresh twice a second
cctop --once       # single frame, then exit
cctop --json       # machine-readable snapshot
```

## Contributing

`cctop` is open source and contributions are welcome — open an issue or send a
pull request on [GitHub](https://github.com/stefanprodan/cctop). See
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) to get set up.

## License

[Apache 2.0](LICENSE)
