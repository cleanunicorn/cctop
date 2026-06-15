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

## Why this needs a status-line hook

cctop is read-only: it reads `~/.claude` and the process table, and makes no
network calls. Claude Code surfaces the limits in exactly two places:
the interactive `/usage` panel, and the`rate_limits` object it passes
to your configured **status-line command** on stdin, once per turn.

So the data already flows past your status line for free. The setup below taps
that stream and writes the latest snapshot to `~/.claude/cctop/usage.json`, which
cctop then reads like any other file — no API key, no network, no stored
secrets. (The only alternative source, the Anthropic OAuth usage endpoint, would
require reading your subscription token and making network calls, which cctop
deliberately does not do.)

This is **opt-in**: without the hook, cctop simply omits the `Limits:` line.

## Setup

You configure a status-line command in `~/.claude/settings.json`. The tap is a
small block added to that command's script — it reads the JSON Claude Code sends
on stdin and persists the `rate_limits` object.

If you don't have a status-line script yet, create one (e.g.
`~/.claude/status/statusline.sh`) and point `settings.json` at it:

```json
{
  "statusLine": { "type": "command", "command": "bash \"$HOME/.claude/status/statusline.sh\"" }
}
```

Then add the tap near the top of the script, right after you read stdin:

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

# ... the rest of your status-line rendering ...
```

The only dependency is [`jq`](https://jqlang.github.io/jq/).

### What it does and why it's safe

The tap reads the same stdin Claude Code already gives your status line and
writes the `rate_limits` object to `~/.claude/cctop/usage.json`. It is
best-effort and self-contained — the whole block is wrapped in `{ … } || true`,
so even under `set -euo pipefail` a failure here can never break your status
line. It is also cheap and robust under many concurrent sessions:

- **Throttled** to ~once per 30s across all sessions (via the file's mtime), so a
  burst of turns or dozens of running instances doesn't spam `jq` and writes.
- **Race-free** — each writer uses its own `mktemp` plus an atomic rename, so
  concurrent taps never corrupt the file (last writer wins; the data is
  identical account-wide anyway).
- **Non-destructive** — only a non-empty `rate_limits` object is written, so a
  missing / `null` / `{}` payload (before the first turn, or on API-key
  accounts) never clobbers a good snapshot.

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
