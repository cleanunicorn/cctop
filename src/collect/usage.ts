// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Account-wide rate-limit usage, captured by the opt-in status-line tap into
// ~/.claude/cctop/usage.json (see docs/usage-limits.md). cctop has no other
// on-disk source for this — Claude Code only surfaces it live, per session.

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
