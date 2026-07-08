// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Claude Code session discovery: correlates the process table with the
// per-pid session registry and the session transcripts, and assembles the
// rows the UI renders. All read-only; spawns nothing.
//
// This module is the orchestrator. Each data source lives in its own collector
// under ./collect/ (sessions, usage, transcript, subagents, process-tree,
// orphans); the per-source caches and their prune() functions are co-located
// there. The two
// invariants that must stay here are candidate selection and the order of the
// two passes: transcripts are read concurrently (Promise.all), then sub-agents
// are attached sequentially so sessions sharing a transcript can't both claim
// the same agents (see attachSubagentsInOrder).

import { statSync } from "node:fs";
import { describeAssistant } from "./collect/entry.ts";
import { attachOrphanPorts, projectForCwd } from "./collect/orphans.ts";
import { projectDir } from "./collect/paths.ts";
import {
  cpuPercent,
  descendants,
  hostApp,
  indexChildren,
  isAgentCmd,
  isClaudeProc,
  pruneCpuSamples,
  subprocsOf,
  versionFromPath,
} from "./collect/process-tree.ts";
import { readSessions, validSession } from "./collect/sessions.ts";
import { parseSettings } from "./collect/settings.ts";
import {
  agentContext,
  attachSubagentsInOrder,
  liveSubagents,
  pruneAgentCache,
} from "./collect/subagents.ts";
import {
  type Details,
  latestTranscript,
  noteEntry,
  pruneTranscriptCache,
  transcriptDetails,
  transcriptDetailsCached,
} from "./collect/transcript.ts";
import type { Instance, InstanceBase, SubProc } from "./collect/types.ts";
import { parseUsage } from "./collect/usage.ts";
import { cwdOf, listAllProcesses, listeningPorts } from "./proc.ts";

export type { History } from "./collect/history.ts";
export { collectHistory } from "./collect/history.ts";
export type { NetRate } from "./collect/network.ts";
export { netThroughput } from "./collect/network.ts";
export type { Settings } from "./collect/settings.ts";
export { readSettings, saveSettings } from "./collect/settings.ts";
export type {
  Instance,
  OrphanPort,
  SubAgent,
  SubProc,
} from "./collect/types.ts";
export type { Usage } from "./collect/usage.ts";
export { captureUsage, readUsage } from "./collect/usage.ts";

// Headless sessions (`claude -p`, SDK-spawned) never write a status to the
// registry, but they do leave a trail — transcript writes and registry
// updatedAt bumps — so infer their state from it the way sub-agent liveness
// is inferred: recent activity is busy, a long-silent one is idle (an SDK
// session parked between turns). The window matches SUBAGENT_BUSY_MS — wide
// enough that a quiet stretch mid tool-call doesn't flicker the row red.
const HEADLESS_BUSY_MS = 180_000;

// A session with a delegated agent CLI (copilot, gemini, codex, …) in its
// sub-process tree has not finished its job — it is waiting on that agent —
// so it reads busy (green) rather than idle (red), whatever the registry
// status says while the shell command runs. Without a registry status, fall
// back to the activity trail (lastMs); "?" only when there is no trail at
// all — a session we truly know nothing about stays dim rather than crying
// wolf in red.
const effectiveState = (
  status: string | null | undefined,
  children: SubProc[],
  lastMs: number,
  nowMs: number,
) => {
  if (children.some((c) => c.agent)) return "busy";
  if (status) return status;
  if (!lastMs) return "?";
  return nowMs - lastMs < HEADLESS_BUSY_MS ? "busy" : "idle";
};

// Does a row match the filter? Searches project, host, branch, model, and
// session id/name. Shared by the snapshot path and the live TUI filter.
export const matchRow = (r: Instance, filter: string | null) =>
  !filter ||
  [r.project, r.host, r.branch, r.model, r.sessionId, r.sessionName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(filter);

// Exported for tests only: the transcript/registry parsers are the pieces most
// exposed to Claude Code's undocumented on-disk formats, so they get covered
// directly. Not part of the public API.
export const __test = {
  validSession,
  parseSettings,
  parseUsage,
  noteEntry,
  describeAssistant,
  transcriptDetails,
  agentContext,
  liveSubagents,
  attachSubagentsInOrder,
  hostApp,
  cpuPercent,
  effectiveState,
  isAgentCmd,
  isClaudeProc,
  versionFromPath,
  indexChildren,
  subprocsOf,
  descendants,
  projectForCwd,
};

export async function collectRows(filter: string | null): Promise<Instance[]> {
  const nowMs = Date.now();
  const procs = listAllProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const sessions = await readSessions();

  const candidates = procs.filter(
    (p) => isClaudeProc(p) || sessions.has(p.pid),
  );
  // every top-level row's PID, so the sub-process tree can exclude all of them
  // (not just the heuristic-detected ones) and never double-list a session
  const candidatePids = new Set(candidates.map((p) => p.pid));

  const childrenOf = indexChildren(procs);

  // drop samples of processes that left the table, so the map stays small;
  // keep sessions and their sub-processes, both of which show a live %CPU
  const current = new Set<number>();
  // for port attribution, a displayed sub-process should also surface the ports
  // of the descendants it spawned: subprocsOf shows the `npm run dev` wrapper
  // while a deeper child (node/vite) owns the actual listening socket. Map each
  // displayed child to its whole subtree, then scan the union of all subtrees.
  const childSubtree = new Map<number, number[]>();
  const portPids = new Set<number>();
  for (const p of candidates) {
    current.add(p.pid);
    for (const c of subprocsOf(p.pid, childrenOf, candidatePids)) {
      current.add(c.pid);
      const subtree = descendants(c.pid, childrenOf, candidatePids);
      childSubtree.set(c.pid, subtree);
      for (const pid of subtree) portPids.add(pid);
    }
  }
  pruneCpuSamples(current);

  // listening ports resolved once for the whole scan, scoped to the
  // sub-process subtrees only: the session (claude/node) procs hold many fds
  // and never listen, so scanning them would waste syscalls on every refresh.
  const portsByPid = listeningPorts(portPids);
  // roll a displayed child's subtree ports up onto its row, sorted and deduped
  const portsFor = (pid: number): number[] => {
    const set = new Set<number>();
    for (const d of childSubtree.get(pid) ?? [pid])
      for (const port of portsByPid.get(d) ?? []) set.add(port);
    return [...set].sort((a, b) => a - b);
  };

  // Transcript reads can overlap across sessions, but sub-agent directory claims
  // happen later in this same candidate order. That keeps sessions which fall
  // back to the same transcript from racing over which row owns the agents.
  const rowBases = await Promise.all(
    candidates.map(async (p): Promise<InstanceBase | null> => {
      let s = sessions.get(p.pid) ?? null;
      // A registry entry whose timestamp does not match the process start means
      // the PID was reused or the entry is malformed.
      if (
        s &&
        (!p.startSec ||
          Math.abs(p.startSec * 1000 - s.startedAt) > 60_000 ||
          s.startedAt > nowMs + 60_000)
      ) {
        s = null;
      }
      if (!s && !isClaudeProc(p)) return null; // stale entry only

      const cwd = s?.cwd ?? cwdOf(p.pid);
      const transcript = s
        ? `${projectDir(s.cwd)}/${s.sessionId}.jsonl`
        : latestTranscript(cwd, p.startSec);
      let mtimeMs = 0;
      if (transcript) {
        try {
          mtimeMs = statSync(transcript).mtimeMs;
        } catch {} // session has not written anything yet
      }
      let details: Details = {};
      if (mtimeMs)
        details = await transcriptDetailsCached(transcript!, mtimeMs);
      const lastMs = Math.max(s?.updatedAt ?? 0, mtimeMs);
      const children = subprocsOf(p.pid, childrenOf, candidatePids)
        .sort((a, b) => b.rss - a.rss || a.pid - b.pid)
        .map((c) => ({
          pid: c.pid,
          name: c.name,
          mem: c.rss,
          cpu: cpuPercent(c, nowMs),
          uptimeSec: c.startSec ? nowMs / 1000 - c.startSec : 0,
          ports: portsFor(c.pid),
          agent: isAgentCmd(c.name),
        }));
      return {
        pid: p.pid,
        mem: p.rss,
        cpu: cpuPercent(p, nowMs),
        uptimeSec: p.startSec ? nowMs / 1000 - p.startSec : 0,
        startSec: p.startSec,
        state: effectiveState(s?.status, children, lastMs, nowMs),
        kind: s?.kind ?? null,
        sessionId: s?.sessionId ?? null,
        sessionName: s?.name ?? null,
        version: s?.version ?? versionFromPath(p.path),
        host: hostApp(p, byPid),
        project: cwd,
        branch: details.branch ?? null,
        model: details.model ?? null,
        contextTokens: details.ctx ?? null,
        lastActivity: lastMs ? new Date(lastMs).toISOString() : null,
        lastMs,
        prompt: details.prompt ?? null,
        promptAt: details.promptAt ?? null,
        lastTurn: details.lastTurn ?? null,
        transcript: mtimeMs ? transcript : null,
        children,
        orphanPorts: [], // filled after all rows are known (attribution by cwd)
      };
    }),
  );

  const seenAgents = new Set<string>();
  const rows = await attachSubagentsInOrder(rowBases, nowMs, seenAgents);
  // leftover dev servers (parent exited, port still open), keyed to sessions by
  // cwd; resolved here since it needs every row's project known up front
  attachOrphanPorts(rows, procs, candidatePids);

  // drop caches for sessions/sub-agents that left the table; each cache is
  // pruned by its owning module so its lifetime stays where it is defined
  pruneTranscriptCache(
    new Set(rows.map((r) => r.transcript).filter((p): p is string => !!p)),
  );
  pruneAgentCache(seenAgents);

  return rows
    .filter((r) => matchRow(r, filter))
    .sort(
      (a, b) =>
        (a.state === "busy" ? 0 : 1) - (b.state === "busy" ? 0 : 1) ||
        b.lastMs - a.lastMs ||
        a.pid - b.pid,
    );
}
