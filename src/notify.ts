// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// "Needs you" notifications: when a session that has been busy flips to
// idle/waiting — Claude finished its turn and is waiting for input — the TUI
// rings the terminal. BEL covers every terminal (visual bell, tmux
// monitor-bell window flags, taskbar urgency); OSC 9 adds a real desktop
// notification where supported (iTerm2, Ghostty, kitty, WezTerm, Windows
// Terminal) and is ignored elsewhere. Pure transition tracking over the rows
// the refresh loop already collects — no timers, processes, or extra reads.

import type { Instance } from "./collect.ts";
import { sanitizeDisplay, shortProject } from "./format.ts";
import { rowKey } from "./render.ts";

// A session must have been busy at least this long before its flip rings:
// a quick turn finishes while the user is still looking at it, and a brief
// registry blip must not ping.
export const MIN_BUSY_MS = 3000;

// Advance the busy-transition tracker one refresh and return the sessions
// whose flip should notify. `busySince` is caller-owned and mutated in place:
// rowKey → the timestamp the session was first observed busy. A key only ever
// enters the map from an observed busy sample, so sessions that start out
// idle (including everything on the first refresh) never ring.
export function finishedSessions(
  busySince: Map<string, number>,
  rows: Instance[],
  now: number,
  minBusyMs: number = MIN_BUSY_MS,
): Instance[] {
  const finished: Instance[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = rowKey(r);
    seen.add(key);
    if (r.state === "busy") {
      if (!busySince.has(key)) busySince.set(key, now);
      continue;
    }
    const since = busySince.get(key);
    if (since === undefined) continue;
    busySince.delete(key);
    // "?" means the registry entry vanished or went stale, not "done"
    if (r.state !== "?" && now - since >= minBusyMs) finished.push(r);
  }
  // sessions that exited while busy are gone, not waiting — never ring
  for (const key of busySince.keys()) if (!seen.has(key)) busySince.delete(key);
  return finished;
}

// The bytes to write when `finished` sessions flipped this refresh: BEL, then
// OSC 9 with a short project/branch message. OSC 777 is deliberately not sent
// alongside — terminals that honor both (e.g. WezTerm) would raise two toasts,
// while BEL already covers the 777-only holdouts. sanitizeDisplay strips any
// control bytes from project/branch names, so the message can never terminate
// the OSC string early or smuggle its own escape sequence.
export function notifySeq(finished: Instance[]): string {
  const first = finished[0];
  const project = shortProject(first.project);
  const where = first.branch ? `${project} (${first.branch})` : project;
  const msg =
    finished.length > 1
      ? `${where} +${finished.length - 1} more are waiting for input`
      : `${where} is waiting for input`;
  return `\x07\x1b]9;cctop: ${sanitizeDisplay(msg)}\x07`;
}
