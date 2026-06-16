// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Account-wide rate-limit usage, captured by the opt-in status-line tap into
// ~/.claude/cctop/usage.json (see docs/usage-limits.md). cctop has no other
// on-disk source for this — Claude Code only surfaces it live, per session.

import { mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CLAUDE_DIR } from "./paths.ts";

export interface Usage {
  sevenDayPct: number | null;
  sevenDayResetsAt: number | null; // epoch seconds
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null; // epoch seconds
  capturedAt: number | null; // epoch seconds the snapshot was written
}

// Written by the opt-in status-line tap; absent for users who haven't set it
// up, so a missing/unreadable/partial file simply means "no limits to show".
const USAGE_FILE = `${CLAUDE_DIR}/cctop/usage.json`;

// Parse the tap's snapshot. The shape is Claude Code's undocumented status-line
// payload, so be defensive: any missing/non-numeric field becomes null, and a
// snapshot with no usable percentage in either window counts as no data.
export function parseUsage(raw: any): Usage | null {
  const rl = raw?.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const usage: Usage = {
    sevenDayPct: num(rl.seven_day?.used_percentage),
    sevenDayResetsAt: num(rl.seven_day?.resets_at),
    fiveHourPct: num(rl.five_hour?.used_percentage),
    fiveHourResetsAt: num(rl.five_hour?.resets_at),
    capturedAt: num(raw.captured_at),
  };
  if (usage.sevenDayPct == null && usage.fiveHourPct == null) return null;
  return usage;
}

export async function readUsage(): Promise<Usage | null> {
  try {
    return parseUsage(await Bun.file(USAGE_FILE).json());
  } catch {
    return null; // not set up, unreadable, or written half-way
  }
}

// Throttle window for captureUsage: at most one write per this interval across
// all sessions (keyed on the file's mtime), so a burst of turns or dozens of
// running instances don't spam the disk.
const CAPTURE_THROTTLE_MS = 30_000;

// The write side of the status-line tap: given the JSON payload Claude Code
// sends a status-line command on stdin, persist its `rate_limits` object to
// usage.json (the shape readUsage/parseUsage expect). Best-effort and safe to
// call from a status line — it never throws, writes nothing on a missing/empty
// payload, throttles, and swaps the file in atomically. Returns whether it
// wrote. `file` is overridable for tests. (Run via `cctop --capture-usage`.)
export async function captureUsage(
  input: string,
  file: string = USAGE_FILE,
): Promise<boolean> {
  try {
    // Throttle first (cheap): skip if the snapshot was refreshed very recently.
    try {
      if (Date.now() - statSync(file).mtimeMs < CAPTURE_THROTTLE_MS)
        return false;
    } catch {} // no file yet — first capture
    const raw = JSON.parse(input);
    const rl = raw?.rate_limits;
    // only a non-empty object: a missing/null/{} payload (before the first turn,
    // or on API-key accounts) must not clobber a good snapshot
    if (
      !rl ||
      typeof rl !== "object" ||
      Array.isArray(rl) ||
      Object.keys(rl).length === 0
    )
      return false;
    const snapshot = JSON.stringify({
      rate_limits: rl,
      captured_at: Math.floor(Date.now() / 1000),
    });
    mkdirSync(dirname(file), { recursive: true });
    // write a temp sibling then rename, so a concurrent reader never sees a
    // partial file and concurrent taps can't corrupt it (last writer wins)
    const tmp = `${file}.${process.pid}.tmp`;
    await Bun.write(tmp, snapshot);
    renameSync(tmp, file);
    return true;
  } catch {
    return false; // a status-line tap must never disrupt rendering
  }
}
