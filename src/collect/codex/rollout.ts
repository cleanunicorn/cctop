// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Resolve a running codex pid to its rollout transcript. Codex does not encode
// the cwd in the rollout path (unlike Claude's per-cwd project dir), so a pid is
// matched to its rollout by start-time + cwd read from the immutable session_meta
// header. Built once per refresh and a no-op when no codex process is live, so a
// Claude-only host pays nothing. Read-only.

import { readdirSync, statSync } from "node:fs";
import { cwdOf } from "../../proc.ts";
import { sessionsRoot } from "./paths.ts";
import { type SessionMeta, sessionMeta } from "./transcript.ts";

// A codex process located on disk: its rollout path (freshly stat'd for the live
// mtime the state/details caches key on) plus the header fields for its row.
export interface CodexResolved {
  path: string;
  mtimeMs: number;
  cwd: string | null;
  sessionId: string | null;
  branch: string | null;
  cliVersion: string | null;
  startMs: number | null;
}

// The live codex processes to resolve (pid + start), passed in by the collector.
export interface CodexProc {
  pid: number;
  startSec: number;
}

// A running rollout is only appended to, never renamed, so once a pid is matched
// its path never changes; memoize it (keyed by pid+start so a recycled pid can't
// inherit a stale match) to skip the readdir/head-read on every later refresh.
const pidPathMemo = new Map<string, string>();
const memoKey = (p: CodexProc) => `${p.pid}:${p.startSec}`;

// The rollout filename embeds the start, and its own mtime is never earlier than
// its start, so only files touched at/after the earliest live codex start can
// belong to one — a cheap stat filter that skips the whole history. The slack
// absorbs clock skew between the process start and the file's first write.
const START_SLACK_MS = 60_000;

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // not a directory, or unreadable
  }
}

// Rollout files under sessions/<YYYY>/<MM>/<DD>/ whose mtime is at/after the
// cutoff. The date dirs are pruned lexically (zero-padded names sort as dates)
// with a one-day slack so a UTC-vs-local partitioning boundary can't drop a match.
function listRecentRollouts(
  cutoffMs: number,
): { path: string; mtimeMs: number }[] {
  const root = sessionsRoot();
  const cut = new Date(cutoffMs - 86_400_000); // 1 day slack for tz/skew
  const p2 = (n: number) => String(n).padStart(2, "0");
  const cutKey = `${cut.getUTCFullYear()}${p2(cut.getUTCMonth() + 1)}${p2(cut.getUTCDate())}`;
  const cutYear = cut.getUTCFullYear();
  const out: { path: string; mtimeMs: number }[] = [];
  for (const y of listDirs(root)) {
    if (!/^\d{4}$/.test(y) || Number(y) < cutYear) continue;
    for (const m of listDirs(`${root}/${y}`)) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of listDirs(`${root}/${y}/${m}`)) {
        if (!/^\d{2}$/.test(d) || `${y}${m}${d}` < cutKey) continue;
        const dir = `${root}/${y}/${m}/${d}`;
        for (const f of listDirs(dir)) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          const path = `${dir}/${f}`;
          try {
            const mtimeMs = statSync(path).mtimeMs;
            if (mtimeMs >= cutoffMs - START_SLACK_MS)
              out.push({ path, mtimeMs });
          } catch {} // vanished between listing and stat
        }
      }
    }
  }
  return out;
}

function resolved(
  path: string,
  mtimeMs: number,
  meta: SessionMeta | null,
): CodexResolved {
  return {
    path,
    mtimeMs,
    cwd: meta?.cwd ?? null,
    sessionId: meta?.sessionId ?? null,
    branch: meta?.branch ?? null,
    cliVersion: meta?.cliVersion ?? null,
    startMs: meta?.startMs ?? null,
  };
}

// Map each live codex pid to its rollout. Short-circuits to an empty map when no
// codex process is live (the common case), so Claude-only hosts touch no disk.
export async function buildCodexIndex(
  procs: CodexProc[],
): Promise<Map<number, CodexResolved>> {
  const out = new Map<number, CodexResolved>();
  // drop memo entries for codex processes that have exited
  const liveKeys = new Set(procs.map(memoKey));
  for (const k of pidPathMemo.keys())
    if (!liveKeys.has(k)) pidPathMemo.delete(k);
  if (!procs.length) return out;

  const unresolved: { proc: CodexProc; cwd: string | null; startMs: number }[] =
    [];
  for (const proc of procs) {
    const memo = pidPathMemo.get(memoKey(proc));
    if (memo) {
      try {
        const mtimeMs = statSync(memo).mtimeMs; // still there → reuse the match
        out.set(proc.pid, resolved(memo, mtimeMs, await sessionMeta(memo)));
        continue;
      } catch {
        pidPathMemo.delete(memoKey(proc)); // rollout gone; fall through to rescan
      }
    }
    unresolved.push({
      proc,
      cwd: cwdOf(proc.pid),
      startMs: proc.startSec * 1000,
    });
  }
  if (!unresolved.length) return out;

  const cutoff = Math.min(...unresolved.map((u) => u.startMs));
  const files = listRecentRollouts(cutoff);
  // read each candidate's header once (cached thereafter) and index by path
  const metas = new Map<string, SessionMeta | null>();
  for (const f of files) metas.set(f.path, await sessionMeta(f.path));

  for (const { proc, cwd, startMs } of unresolved) {
    let best: {
      path: string;
      mtimeMs: number;
      meta: SessionMeta;
      delta: number;
    } | null = null;
    for (const f of files) {
      const meta = metas.get(f.path);
      if (!meta || meta.startMs == null) continue;
      if (cwd != null && meta.cwd !== cwd) continue; // wrong project
      const delta = Math.abs(meta.startMs - startMs);
      if (delta > START_SLACK_MS) continue; // not this pid's session
      if (!best || delta < best.delta)
        best = { path: f.path, mtimeMs: f.mtimeMs, meta, delta };
    }
    if (best) {
      pidPathMemo.set(memoKey(proc), best.path);
      out.set(proc.pid, resolved(best.path, best.mtimeMs, best.meta));
    }
  }
  return out;
}

// Exported for tests only.
export const __codexTest = { listRecentRollouts, buildCodexIndex };
