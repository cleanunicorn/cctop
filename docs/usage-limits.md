# Weekly usage limits

cctop can show your Claude subscription's rate-limit usage in the summary line:

```
Limits: 8% 7d (2d9h left)  60% 5h (2h32m left)
```

- **`7d`** — the rolling 7-day ("weekly") window, across all models.
- **`5h`** — the rolling 5-hour window.
- **`(… left)`** — time until each window resets, or `(due)` once a window's
  reset time has passed but the snapshot hasn't refreshed yet.

The percentages heat toward red as they climb, like the CPU and context columns.

## Setup

You configure a status-line command in `~/.claude/settings.json`. The tap is a
small block added to that command's script. It reads the JSON Claude Code sends
on stdin and persists the `rate_limits` object.

If you don't have a status-line script yet, create one (e.g.
`~/.claude/statusline.sh`) and point `settings.json` at it:

```json
{
  "statusLine": { "type": "command", "command": "bash \"$HOME/.claude/statusline.sh\"" }
}
```

Then add the tap near the top of the script, right after you read stdin:

```bash
input=$(cat)

# persist the account-wide 5h/7d rate limits
printf '%s' "$input" | cctop --capture-usage || true

# ... the rest of your status-line rendering, using "$input" ...
```

### A complete example script

If you don't have a status-line script at all, here's a self-contained
`~/.claude/statusline.sh` to start from. It runs the tap, then renders a compact
`model · dir · git:branch` line; trim or replace the rendering to taste — the
only line cctop needs is the `cctop --capture-usage` tap.

> **Requires [`jq`](https://jqlang.github.io/jq/).** Only the *rendering* below
> uses it (to read fields out of the stdin payload); cctop itself stays
> dependency-free and the tap never needs `jq`. Install it with
> `brew install jq` (macOS) or `apt install jq` (Debian/Ubuntu), or drop the
> `jq` lines and print your own status text instead.

```bash
#!/usr/bin/env bash
# Claude Code status line, with the cctop usage-limits tap.
# Claude Code pipes a JSON payload to this command on stdin once per turn;
# whatever we print to stdout becomes the rendered status line.

input=$(cat)

# persist the account-wide 5h/7d rate limits for cctop (best-effort; the
# `|| true` keeps a missing/failed cctop from tripping a status line under `set -e`)
printf '%s' "$input" | cctop --capture-usage || true

# --- render the status line (stdout is the rendered text) ---
model=$(printf '%s' "$input" | jq -r '.model.display_name // empty')
dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')
dir_name=""
[ -n "$dir" ] && dir_name=$(basename "$dir")

branch=""
if [ -n "$dir" ] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$dir" branch --show-current 2>/dev/null)
fi

line="$model"
[ -n "$dir_name" ] && line="$line · $dir_name"
[ -n "$branch" ] && line="$line · git:$branch"
printf '%s' "$line"
```

Make it executable (`chmod +x ~/.claude/statusline.sh`) and point
`settings.json` at it as shown above.

The`cctop --capture-usage` reads the payload on stdin and
writes the snapshot; the `|| true` keeps a missing or failed `cctop` from
tripping a status line that runs under `set -e`.

### What it does and why it's safe

`cctop --capture-usage` reads the same stdin Claude Code already gives your
status line and writes the `rate_limits` object to `~/.claude/cctop/usage.json`.
It is best-effort and cannot disrupt your status line:

- **Silent and non-failing** — it prints nothing (your status line's stdout is
  its rendered text) and always exits 0, even on a malformed payload, so it is
  safe even under `set -euo pipefail` (the `|| true` only guards `cctop` itself
  being absent from `PATH`).
- **Throttled** to ~once per 30s across all sessions (via the file's mtime), so a
  burst of turns or dozens of running instances doesn't spam writes.
- **Race-free** — each write goes to a temp file and is renamed into place
  atomically, so concurrent taps never corrupt the file (last writer wins; the
  data is identical account-wide anyway).
- **Non-destructive** — only a non-empty `rate_limits` object is written, so a
  missing / `null` / `{}` payload (before the first turn, or on API-key
  accounts) never clobbers a good snapshot.

## Why this needs a status-line hook

cctop's monitor is read-only: it reads `~/.claude` and the process table, and
makes no network calls (its only network access is the explicit `cctop upgrade`
command). Claude Code surfaces the limits in exactly two places:
the interactive `/usage` panel, and the`rate_limits` object it passes
to your configured **status-line command** on stdin, once per turn.

So the data already flows past your status line for free. The setup taps
that stream and writes the latest snapshot to `~/.claude/cctop/usage.json`, which
cctop then reads like any other file — no API key, no network, no stored
secrets. (The only alternative source, the Anthropic OAuth usage endpoint, would
require reading your subscription token and making network calls, which cctop
deliberately does not do.)

This is **opt-in**: without the hook, cctop simply omits the `Limits:` line.

## The file cctop reads

`~/.claude/cctop/usage.json`:

```jsonc
{
  "rate_limits": {
    "five_hour": { "used_percentage": 0, "resets_at": 1781544600 },
    "seven_day": { "used_percentage": 8, "resets_at": 1781568000 }
  },
  "captured_at": 1781527457
}
```

`resets_at` and `captured_at` are unix epoch seconds.

## Notes

- **Subscription accounts only.** The `rate_limits` field is present for Pro/Max
  subscribers, after the first turn of a session. API-key accounts don't get it,
  so the `Limits:` line stays hidden.
- **Freshness follows activity.** The snapshot updates only while a session
  renders its status line. Once it's over an hour old, cctop appends its age,
  e.g. `Limits: 8% 7d (2d left)  · 2h ago`, so a stale reading isn't mistaken
  for a live one. The `(… left)` countdowns come from the absolute reset time,
  so they stay accurate regardless.
- **Aggregate only.** The status-line payload carries just the combined 5h/7d
  windows — not the per-model breakdown the `/usage` panel shows. `7d` is the
  all-models weekly figure.
