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
import { buildCodexIndex } from "./collect/codex/rollout.ts";
import {
  codexState,
  pruneCodexTranscriptCaches,
  rolloutDetails,
  rolloutDetailsCached,
  sessionMeta,
  toDetails,
} from "./collect/codex/transcript.ts";
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
  isCodexProc,
  pruneCpuSamples,
  subprocsOf,
  versionFromPath,
} from "./collect/process-tree.ts";
import { readSessions, validSession } from "./collect/sessions.ts";
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
export type {
  Instance,
  OrphanPort,
  SubAgent,
  SubProc,
} from "./collect/types.ts";
export type { Usage } from "./collect/usage.ts";
export { captureUsage, readUsage } from "./collect/usage.ts";

// A session with a delegated agent CLI (copilot, gemini, codex, …) in its
// sub-process tree has not finished its job — it is waiting on that agent —
// so it reads busy (green) rather than idle (red), whatever the registry
// status says while the shell command runs.
const effectiveState = (
  status: string | null | undefined,
  children: SubProc[],
) => (children.some((c) => c.agent) ? "busy" : (status ?? "?"));

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
  isCodexProc,
  versionFromPath,
  indexChildren,
  subprocsOf,
  descendants,
  projectForCwd,
  sessionMeta,
  rolloutDetails,
  codexState,
  buildCodexIndex,
};

export async function collectRows(filter: string | null): Promise<Instance[]> {
  const nowMs = Date.now();
  const procs = listAllProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const sessions = await readSessions();

  const candidates = procs.filter(
    (p) => isClaudeProc(p) || isCodexProc(p) || sessions.has(p.pid),
  );
  // Resolve every live codex process to its rollout transcript in one pass (a
  // no-op when none are running). Codex has no per-pid registry, so this stands
  // in for readSessions(): it maps pid -> {rollout path, cwd, branch, id, …}.
  const codexIndex = await buildCodexIndex(
    candidates
      .filter((p) => !sessions.has(p.pid) && isCodexProc(p))
      .map((p) => ({ pid: p.pid, startSec: p.startSec })),
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
      // a standalone codex process is not a Claude session (it has no registry
      // entry); resolve it from its rollout in the codex branch below instead
      const codex = !s && isCodexProc(p);
      if (!s && !codex && !isClaudeProc(p)) return null; // stale entry only

      // the sub-process tree and host are provider-neutral, so derive them once
      // and share them across both the codex and Claude row assembly below
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
      const base = {
        pid: p.pid,
        mem: p.rss,
        cpu: cpuPercent(p, nowMs),
        uptimeSec: p.startSec ? nowMs / 1000 - p.startSec : 0,
        startSec: p.startSec,
        host: hostApp(p, byPid),
        children,
        orphanPorts: [], // filled after all rows are known (attribution by cwd)
      };

      // codex: no per-pid registry and no status file, so the rollout index
      // supplies cwd/branch/id and the tail parser supplies model/ctx/prompt;
      // busy/idle is inferred (codexState) since codex writes no status.
      if (codex) {
        const r = codexIndex.get(p.pid) ?? null;
        const cwd = r?.cwd ?? cwdOf(p.pid);
        let details: Details = {};
        let status: string | null = null;
        if (r) {
          const rd = await rolloutDetailsCached(r.path, r.mtimeMs);
          details = toDetails(r, rd);
          status = codexState(rd.running, r.mtimeMs, nowMs);
        }
        const lastMs = r?.mtimeMs ?? 0;
        return {
          ...base,
          provider: "codex",
          state: effectiveState(status, children),
          kind: "codex",
          sessionId: r?.sessionId ?? null,
          sessionName: null,
          version: r?.cliVersion ?? null,
          project: cwd,
          branch: details.branch ?? null,
          model: details.model ?? null,
          contextTokens: details.ctx ?? null,
          lastActivity: lastMs ? new Date(lastMs).toISOString() : null,
          lastMs,
          prompt: details.prompt ?? null,
          promptAt: details.promptAt ?? null,
          lastTurn: details.lastTurn ?? null,
          transcript: r?.path ?? null,
        };
      }

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
      return {
        ...base,
        provider: "claude",
        state: effectiveState(s?.status, children),
        kind: s?.kind ?? null,
        sessionId: s?.sessionId ?? null,
        sessionName: s?.name ?? null,
        version: s?.version ?? versionFromPath(p.path),
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
  // codex meta/details caches keyed to the rollouts still backing a live row
  pruneCodexTranscriptCaches(
    new Set([...codexIndex.values()].map((r) => r.path)),
  );

  return rows
    .filter((r) => matchRow(r, filter))
    .sort(
      (a, b) =>
        (a.state === "busy" ? 0 : 1) - (b.state === "busy" ? 0 : 1) ||
        b.lastMs - a.lastMs ||
        a.pid - b.pid,
    );
}
