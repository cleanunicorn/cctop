// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The row types the collectors assemble and the renderer consumes. Kept in a
// leaf module so the collector modules and the orchestrator can share them
// without importing back through collect.ts.

export interface SubProc {
  pid: number;
  name: string;
  mem: number;
  cpu: number;
  uptimeSec: number;
}

export interface SubAgent {
  model: string | null;
  ctx: number | null;
  activity: string | null;
  uptimeSec: number;
}

export interface Instance {
  pid: number;
  mem: number;
  cpu: number;
  uptimeSec: number;
  startSec: number;
  state: string;
  kind: string | null;
  sessionId: string | null;
  sessionName: string | null;
  version: string | null;
  host: string;
  project: string | null;
  branch: string | null;
  model: string | null;
  contextTokens: number | null;
  lastActivity: string | null;
  lastMs: number;
  prompt: string | null;
  promptAt: number | null; // unix ms of the last user prompt
  lastTurn: string | null; // the action the agent's most recent turn took
  transcript: string | null;
  subagents: SubAgent[];
  children: SubProc[];
}

// An instance before its live sub-agents are attached (the second, sequential
// pass). collectRows builds these concurrently, then fills in `subagents`.
export type InstanceBase = Omit<Instance, "subagents">;
