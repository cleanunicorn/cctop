// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Process-table derived columns: which process is a Claude session, the host
// app that owns it, the sub-process tree it spawned, and per-process %CPU
// (sampled across refreshes). Pure over the Proc table plus a small CPU-sample
// cache; read-only.

import type { Proc } from "../proc.ts";

// The version-named executable lives under .../claude/versions/2.1.176
export const isClaudeProc = (p: Proc) =>
  p.name === "claude" || /\/claude\/versions\/\d/.test(p.path ?? "");

export const versionFromPath = (path: string | null) =>
  path
    ?.split("/")
    .pop()
    ?.match(/^\d+\.\d+(\.\d+)?/)?.[0] ?? null;

// First ancestor past shells and wrappers identifies what hosts the
// session: a macOS app bundle (iTerm, Ghostty, GoLand, Visual Studio
// Code, Claude...), tmux, or sshd.
const HOST_SKIP = new Set([
  "op",
  "sudo",
  "env",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "login",
  "script",
  "direnv",
]);

// Shells that wrap a tool command; the sub-process tree descends through
// these to show the real command rather than the shell (see subprocsOf).
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);

export function hostApp(proc: Proc, byPid: Map<number, Proc>): string {
  let p: Proc | undefined = proc;
  for (let i = 0; i < 20; i++) {
    p = byPid.get(p.ppid);
    if (!p || p.pid <= 1) break;
    const app = p.path?.match(/\/([^/]+)\.app\//); // outermost bundle
    if (app) return app[1];
    // a session spawned by another Claude (a bg job / sub-session) is hosted by
    // that parent; report it as "claude" rather than the versioned exec name
    // ("2.1.177") the nested process carries
    if (isClaudeProc(p)) return "claude";
    const base = (p.name ?? "").toLowerCase();
    if (base.startsWith("tmux")) return "tmux";
    if (base.startsWith("sshd")) return "ssh";
    if (!HOST_SKIP.has(base)) return p.name;
  }
  return "?";
}

// index every process by its parent so each session can list the
// sub-processes it spawned (tool shells, MCP servers, caffeinate...)
export function indexChildren(procs: Proc[]): Map<number, Proc[]> {
  const childrenOf = new Map<number, Proc[]>();
  for (const c of procs) {
    const arr = childrenOf.get(c.ppid);
    if (arr) arr.push(c);
    else childrenOf.set(c.ppid, [c]);
  }
  return childrenOf;
}

// A session's effective sub-processes: descend through shells running tool
// commands (claude's Bash tool spawns `bash -c '...'`, occasionally nested)
// down to the real command, keeping the outermost shell as a single prefix
// so context is preserved without piling up layers ("bash › go", not
// "bash › bash › go"). A shell with nothing under it is just an idle
// wrapper between commands and is dropped. The depth cap guards cycles.
function resolveProc(
  proc: Proc,
  prefix: string | null,
  depth: number,
  childrenOf: Map<number, Proc[]>,
  candidatePids: Set<number>,
): Proc[] {
  // A nested session (a bg job or sub-session spawned by this one) is itself a
  // top-level candidate and gets its own row, so it must not also appear here
  // as a sub-process: its versioned exec name ("2.1.177") would land in the
  // name slot — the CTX column on a session row — reading like a stray
  // version where the context should be. Its own children hang off its row.
  // We key off the candidate set rather than isClaudeProc alone so sessions
  // found only via the registry (and missed by the executable heuristic) are
  // excluded too — otherwise they would still double-list.
  if (candidatePids.has(proc.pid)) return [];
  const kids = childrenOf.get(proc.pid) ?? [];
  if (depth < 8 && SHELL_NAMES.has(proc.name) && kids.length) {
    const label = prefix ?? proc.name;
    return kids.flatMap((k) =>
      resolveProc(k, label, depth + 1, childrenOf, candidatePids),
    );
  }
  if (SHELL_NAMES.has(proc.name)) return []; // childless shell, skip
  const name = prefix ? `${prefix} › ${proc.name}` : proc.name;
  return [{ ...proc, name }];
}

export function subprocsOf(
  pid: number,
  childrenOf: Map<number, Proc[]>,
  candidatePids: Set<number>,
): Proc[] {
  return (childrenOf.get(pid) ?? []).flatMap((c) =>
    resolveProc(c, null, 0, childrenOf, candidatePids),
  );
}

// Every pid in the subtree rooted at `root` (inclusive), without crossing into
// a nested session (candidatePids) — those get their own rows, so their
// listeners must not roll up here. Used for port attribution: a displayed
// sub-process should own the ports of the descendants it spawned, since
// subprocsOf shows the wrapper (`npm run dev`) while a deeper child (node/vite)
// holds the actual listening socket. The counter caps a pathological cycle.
export function descendants(
  root: number,
  childrenOf: Map<number, Proc[]>,
  candidatePids: Set<number>,
): number[] {
  const out: number[] = [];
  const stack = [root];
  for (let guard = 0; stack.length && guard < 10_000; guard++) {
    const pid = stack.pop()!;
    out.push(pid);
    for (const c of childrenOf.get(pid) ?? [])
      if (!candidatePids.has(c.pid)) stack.push(c.pid);
  }
  return out;
}

// %CPU: like top, the delta between two samples (watch refreshes); on the
// first sample it falls back to the average since the process started.
const cpuSamples = new Map<number, { cpuSec: number; atMs: number }>();
export function cpuPercent(p: Proc, nowMs: number) {
  const prev = cpuSamples.get(p.pid);
  cpuSamples.set(p.pid, { cpuSec: p.cpuSec, atMs: nowMs });
  if (prev && nowMs - prev.atMs > 200) {
    // clamp: cpuSec can drop after PID reuse, yielding a negative delta
    return Math.max(
      0,
      ((p.cpuSec - prev.cpuSec) / ((nowMs - prev.atMs) / 1000)) * 100,
    );
  }
  const elapsed = nowMs / 1000 - p.startSec;
  return elapsed > 0 ? (p.cpuSec / elapsed) * 100 : 0;
}

// Drop samples of processes that left the table, so the map stays small.
// `keep` is the set of pids still shown (sessions and their sub-processes).
export function pruneCpuSamples(keep: Set<number>) {
  for (const pid of cpuSamples.keys()) {
    if (!keep.has(pid)) cpuSamples.delete(pid);
  }
}
