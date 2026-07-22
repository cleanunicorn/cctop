// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The per-pid session registry: ~/.claude/sessions/<pid>.json, one file per
// running Claude Code. Read-only.

import { readdirSync } from "node:fs";
import { CLAUDE_DIR } from "./paths.ts";

interface Session {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  version?: string;
  kind?: string;
  status?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
  name?: string;
}

export type { Session };

// A session writes an "idle" status ~100ms into startup, before it has run a
// single turn and without ringing anything. Requiring the flip to land clear of
// that write is what keeps a freshly launched (or resumed) session from ringing.
const STARTUP_GRACE_MS = 2_000;

// When this session last stopped working and rang the terminal bell for you, or
// null if it is still working.
//
// Claude Code rewrites <pid>.json only when `status` flips — there is no
// heartbeat — so `statusUpdatedAt` on a stopped session is the exact instant it
// stopped, which is the instant it rings. Anything that is not "busy" counts as
// stopped, matching stateDot(): Claude Code coins new statuses over time, and a
// session that isn't working may want you whatever it calls that.
//
// Imperfect in one direction: interrupting a turn (esc) also flips the status,
// and no bell rings for that. It reads as a bell for BELL_MS, then decays.
export function bellTime(s: Session): number | null {
  if (!s.status || s.status === "busy" || s.statusUpdatedAt == null)
    return null;
  const sinceStart = s.statusUpdatedAt - s.startedAt;
  return sinceStart > STARTUP_GRACE_MS ? s.statusUpdatedAt : null;
}

// The bell a row carries, reconciling the registry against the state the row
// actually displays. Two cases where the registry alone would lie:
//
//   - A session waiting on a delegated agent CLI (copilot, gemini, …) reads
//     "idle" in the registry, but effectiveState() shows it busy because it has
//     not finished its job. A green row must not wear a red bell.
//   - A headless session (`claude -p`, SDK) writes no status at all, so
//     effectiveState() infers idle from its activity trail. bellTime() returns
//     null for it — inferred silence is not a ring.
//
// Takes the *effective* state, not the registry status, so the bell and the
// status dot can never contradict each other.
export function bellFor(
  s: Session | null | undefined,
  state: string,
): number | null {
  if (!s || state === "busy") return null;
  return bellTime(s);
}

// ~/.claude/sessions/<pid>.json is written by each running Claude Code:
// { pid, sessionId, cwd, startedAt, version, kind, status, updatedAt,
//   statusUpdatedAt, name }
export function validSession(raw: any, file: string): Session | null {
  const filePid = Number(file.slice(0, -".json".length));
  if (
    !Number.isInteger(filePid) ||
    raw?.pid !== filePid ||
    typeof raw.sessionId !== "string" ||
    raw.sessionId.length === 0 ||
    typeof raw.cwd !== "string" ||
    raw.cwd.length === 0 ||
    !Number.isFinite(raw.startedAt)
  ) {
    return null;
  }
  const optionalString = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    startedAt: raw.startedAt,
    version: optionalString(raw.version),
    kind: optionalString(raw.kind),
    status: optionalString(raw.status),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined,
    statusUpdatedAt: Number.isFinite(raw.statusUpdatedAt)
      ? raw.statusUpdatedAt
      : undefined,
    name: optionalString(raw.name),
  };
}

export async function readSessions(): Promise<Map<number, Session>> {
  const byPid = new Map<number, Session>();
  let files: string[] = [];
  try {
    files = readdirSync(`${CLAUDE_DIR}/sessions`);
  } catch {
    return byPid;
  }
  await Promise.all(
    files.map(async (f) => {
      if (!f.endsWith(".json")) return;
      try {
        const raw = await Bun.file(`${CLAUDE_DIR}/sessions/${f}`).json();
        const s = validSession(raw, f);
        if (s) byPid.set(s.pid, s);
      } catch {} // missing or partially written entry
    }),
  );
  return byPid;
}
