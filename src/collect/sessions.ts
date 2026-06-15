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
  name?: string;
}

export type { Session };

// ~/.claude/sessions/<pid>.json is written by each running Claude Code:
// { pid, sessionId, cwd, startedAt, version, kind, status, updatedAt, name }
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
