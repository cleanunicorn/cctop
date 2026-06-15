// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Claude Code session discovery: correlates the process table with the
// per-pid session registry and the session transcripts, and assembles the
// rows the UI renders. All read-only; spawns nothing.

import {
  closeSync,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { truncate } from "./format.ts";
import { cwdOf, listAllProcesses, type Proc } from "./proc.ts";

const CLAUDE_DIR = `${homedir()}/.claude`;

// The last prompt is a preview, not a faithful copy (the detail view shows the
// transcript path for the real thing). Cap it so a pasted blob can't bloat the
// row, the per-frame sanitize, or the detail wrap. ~25 lines at 80 cols.
const PROMPT_MAX = 2048;

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

// Account-wide rate-limit usage, captured by the status-line tap into
// ~/.claude/cctop/usage.json (see docs/usage-limits.md). cctop has no other
// on-disk source for this — Claude Code only surfaces it live, per session.
export interface Usage {
  sevenDayPct: number | null;
  sevenDayResetsAt: number | null; // epoch seconds
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null; // epoch seconds
  capturedAt: number | null; // epoch seconds the snapshot was written
}

export interface Row {
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
  transcript: string | null;
  subagents: SubAgent[];
  children: SubProc[];
}

// Does a row match the filter? Searches project, host, branch, model, and
// session id/name. Shared by the snapshot path and the live TUI filter.
export const matchRow = (r: Row, filter: string | null) =>
  !filter ||
  [r.project, r.host, r.branch, r.model, r.sessionId, r.sessionName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(filter);

// The version-named executable lives under .../claude/versions/2.1.176
const isClaudeProc = (p: Proc) =>
  p.name === "claude" || /\/claude\/versions\/\d/.test(p.path ?? "");

const versionFromPath = (path: string | null) =>
  path
    ?.split("/")
    .pop()
    ?.match(/^\d+\.\d+(\.\d+)?/)?.[0] ?? null;

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

// ~/.claude/sessions/<pid>.json is written by each running Claude Code:
// { pid, sessionId, cwd, startedAt, version, kind, status, updatedAt, name }
function validSession(raw: any, file: string): Session | null {
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
  hostApp,
  cpuPercent,
  isClaudeProc,
  versionFromPath,
  indexChildren,
  subprocsOf,
};

function readSessions(): Map<number, Session> {
  const byPid = new Map<number, Session>();
  let files: string[] = [];
  try {
    files = readdirSync(`${CLAUDE_DIR}/sessions`);
  } catch {
    return byPid;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(
        readFileSync(`${CLAUDE_DIR}/sessions/${f}`, "utf8"),
      );
      const s = validSession(raw, f);
      if (s) byPid.set(s.pid, s);
    } catch {} // partially written entry
  }
  return byPid;
}

// Written by the opt-in status-line tap; absent for users who haven't set it
// up, so a missing/unreadable/partial file simply means "no limits to show".
const USAGE_FILE = `${CLAUDE_DIR}/cctop/usage.json`;

// Parse the tap's snapshot. The shape is Claude Code's undocumented status-line
// payload, so be defensive: any missing/non-numeric field becomes null, and a
// snapshot with no usable percentage in either window counts as no data.
function parseUsage(raw: any): Usage | null {
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

export function readUsage(): Usage | null {
  try {
    return parseUsage(JSON.parse(readFileSync(USAGE_FILE, "utf8")));
  } catch {
    return null; // not set up, unreadable, or written half-way
  }
}

// Transcripts live under a directory derived from the session's cwd
const projectDir = (cwd: string) =>
  `${CLAUDE_DIR}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;

// Without a registry entry, fall back to the project's most recently
// modified transcript that has been written since the process started.
function latestTranscript(cwd: string | null, startSec: number) {
  if (!cwd) return null;
  const dir = projectDir(cwd);
  let best: { path: string; mtimeMs: number } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const mtimeMs = statSync(`${dir}/${f}`).mtimeMs;
      if (mtimeMs < startSec * 1000 - 60_000) continue;
      if (!best || mtimeMs > best.mtimeMs)
        best = { path: `${dir}/${f}`, mtimeMs };
    }
  } catch {} // no transcripts for this project
  return best?.path ?? null;
}

interface Details {
  branch?: string;
  model?: string;
  ctx?: number;
  prompt?: string;
}

// Note what a transcript entry contributes: the newest model + context
// size (last main-thread assistant turn), git branch, and last user
// prompt. Returns true once all details are known.
function noteEntry(details: Details, e: any) {
  details.branch ??= e.gitBranch || undefined;
  // synthetic turns (interrupts, errors, injected notices) carry a
  // "<synthetic>" model and zeroed usage; skip them for the real last turn
  if (
    !details.model &&
    e.type === "assistant" &&
    !e.isSidechain &&
    e.message?.usage &&
    e.message.model &&
    e.message.model !== "<synthetic>"
  ) {
    const u = e.message.usage;
    details.model = e.message.model;
    details.ctx =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
  }
  if (!details.prompt && e.type === "user" && !e.isMeta && !e.isSidechain) {
    const c = e.message?.content;
    let text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.find((b: any) => b.type === "text")?.text
          : null;
    if (text) {
      // slash commands arrive wrapped in <command-name>/<command-args>
      const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
      if (cmd) {
        const cmdArgs = text.match(/<command-args>([^<]*)<\/command-args>/);
        text = `${cmd[1]} ${cmdArgs?.[1] ?? ""}`;
      }
      text = text.replace(/\s+/g, " ").trim();
      // skip other harness wrappers like <local-command-stdout>
      if (text && !text.startsWith("<"))
        details.prompt = truncate(text, PROMPT_MAX);
    }
  }
  return Boolean(details.model && details.prompt && details.branch);
}

// Scan a transcript backwards in chunks from the end, stopping as soon
// as every detail is found. Long sessions grow to tens of MB, and big
// tool results can push the last user prompt far from the tail, so a
// fixed tail window is not enough; the scan is still bounded.
const TAIL_CHUNK = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

// Synchronous on purpose: Bun's async file I/O (Bun.file) can stall when the
// process also holds the TTY in raw mode on the alternate screen (as the live
// TUI does), so the tail scan uses node:fs readSync, which is unaffected.
function transcriptDetails(path: string): Details {
  const details: Details = {};
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return details; // gone or unreadable
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return details;
    // bytes (not text: chunk cuts can split multibyte chars) of the line
    // straddling the current chunk boundary, completed by the next chunk
    let carry = Buffer.alloc(0);
    let end = size;
    while (end > 0 && size - end < MAX_TAIL_BYTES) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const len = end - start;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      const block = Buffer.concat([buf, carry]);
      let parseFrom = 0;
      if (start > 0) {
        const nl = block.indexOf(10);
        if (nl < 0) {
          carry = block; // one line larger than the whole chunk
          end = start;
          continue;
        }
        carry = block.subarray(0, nl);
        parseFrom = nl + 1;
      }
      const lines = block.subarray(parseFrom).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        let entry: any;
        try {
          entry = JSON.parse(lines[i]);
        } catch {
          continue; // line being appended right now
        }
        if (noteEntry(details, entry)) return details;
      }
      end = start;
    }
  } catch {
    // unreadable (permissions)
  } finally {
    closeSync(fd);
  }
  return details;
}

// Sub-agents (Task / Workflow) run in-process, so they never appear in the
// process table; instead each writes its own transcript under the session's
// subagents/ directory (workflow agents nest one level deeper under
// workflows/<id>/). A sub-agent counts as live if it wrote a turn very
// recently (fast tool steps) or if its last turn is mid-flight — a tool call
// awaiting its result — which stays quiet on disk during a slow tool but the
// agent is very much still running. Past the busy cap it is treated as done.
const SUBAGENT_LIVE_MS = 20_000; // wrote a turn this recently
const SUBAGENT_BUSY_MS = 180_000; // quiet but mid tool-call
const agentCache = new Map<string, any>(); // agent path -> { mtimeMs, model, ctx, ... }

function listAgentFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // no subagents directory for this session
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...listAgentFiles(p));
    else if (e.name.startsWith("agent-") && e.name.endsWith(".jsonl"))
      out.push(p);
  }
  return out;
}

// What an agent is doing right now, from its latest assistant turn: the most
// recent tool call (tool + its key argument) or, failing that, a snippet of
// the latest message text. Agents have no real name, so this is the label.
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);
function describeAssistant(msg: any): string | null {
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return null;
  const tool = [...blocks].reverse().find((b) => b?.type === "tool_use");
  if (tool) {
    const inp = tool.input ?? {};
    let arg = String(
      inp.command ??
        inp.pattern ??
        inp.query ??
        inp.url ??
        inp.file_path ??
        inp.path ??
        inp.description ??
        inp.subagent_type ??
        "",
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (FILE_TOOLS.has(tool.name) && arg.includes("/"))
      arg = arg.split("/").pop()!;
    return arg ? `${tool.name}: ${arg}` : tool.name;
  }
  const text = [...blocks].reverse().find((b) => b?.type === "text")?.text;
  return text ? text.replace(/\s+/g, " ").trim() : null;
}

const hasBlock = (msg: any, type: string) =>
  Array.isArray(msg?.content) && msg.content.some((b: any) => b?.type === type);

// An agent transcript's turns are all marked isSidechain, so the main scanner
// skips them; read the tail for the latest model, context size, activity, and
// whether the agent is mid-flight. Synchronous for the same reason as
// transcriptDetails.
function agentContext(path: string) {
  const out: {
    model?: string;
    ctx?: number;
    activity?: string | null;
    running: boolean;
  } = { running: false };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return out;
  }
  try {
    const size = fstatSync(fd).size;
    const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const tail = buf.toString("utf8");
    const entries: any[] = [];
    for (const line of tail.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {} // partial line at the slice boundary or being appended
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "assistant" && e.message?.usage) {
        const u = e.message.usage;
        out.model = e.message.model;
        out.ctx =
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        out.activity = describeAssistant(e.message);
        break;
      }
    }
    // mid-flight: a tool call was issued (awaiting its result) or a result
    // just arrived (awaiting the next turn). A final text-only assistant turn
    // means the agent finished, so the mtime window alone governs it.
    const last = entries.at(-1);
    out.running =
      !!last &&
      ((last.type === "assistant" && hasBlock(last.message, "tool_use")) ||
        (last.type === "user" && hasBlock(last.message, "tool_result")));
  } catch {
    // unreadable
  } finally {
    closeSync(fd);
  }
  return out;
}

// The session's currently-running sub-agents: agent transcripts touched within
// the live window, each with its own context size (cached by mtime). The
// subagents directory sits next to the transcript: <...>/<id>.jsonl ->
// <...>/<id>/subagents (works whether or not the session has a registry entry).
function liveSubagents(
  transcript: string | null,
  nowMs: number,
  seen: Set<string>,
  seenDirs: Set<string>,
): SubAgent[] {
  if (!transcript) return [];
  const dir = `${transcript.replace(/\.jsonl$/, "")}/subagents`;
  // two sessions in one project can fall back to the same transcript; only
  // the first to claim a subagents dir lists its agents, so they show once
  if (seenDirs.has(dir)) return [];
  seenDirs.add(dir);
  const out: SubAgent[] = [];
  for (const path of listAgentFiles(dir)) {
    let mtimeMs: number;
    let birthMs: number;
    try {
      const st = statSync(path);
      mtimeMs = st.mtimeMs;
      // the transcript is created when the agent starts and only appended to,
      // so its birthtime is the agent's start; fall back to mtime where the
      // filesystem has no birthtime (uptime then reads ~0 rather than bogus)
      birthMs = st.birthtimeMs || st.mtimeMs;
    } catch {
      continue;
    }
    const age = nowMs - mtimeMs;
    if (age > SUBAGENT_BUSY_MS) continue; // long gone
    seen.add(path);
    let info = agentCache.get(path);
    if (!info || info.mtimeMs !== mtimeMs) {
      info = { mtimeMs, ...agentContext(path) };
      agentCache.set(path, info);
    }
    // live if it wrote a turn recently, or it is quietly running a tool call
    if (age > SUBAGENT_LIVE_MS && !info.running) continue;
    out.push({
      model: info.model ?? null,
      ctx: info.ctx ?? null,
      activity: info.activity ?? null,
      uptimeSec: Math.max(0, (nowMs - birthMs) / 1000),
    });
  }
  return out.sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0));
}

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

function hostApp(proc: Proc, byPid: Map<number, Proc>): string {
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

// Parsed transcript details cached by path; reused while the file's mtime is
// unchanged so an idle session is not re-scanned (up to MAX_TAIL_BYTES) every
// refresh. Stale paths are pruned each cycle in collectRows.
const transcriptCache = new Map<
  string,
  { mtimeMs: number; details: Details }
>();

// %CPU: like top, the delta between two samples (watch refreshes); on the
// first sample it falls back to the average since the process started.
const cpuSamples = new Map<number, { cpuSec: number; atMs: number }>();
function cpuPercent(p: Proc, nowMs: number) {
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

// index every process by its parent so each session can list the
// sub-processes it spawned (tool shells, MCP servers, caffeinate...)
function indexChildren(procs: Proc[]): Map<number, Proc[]> {
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

function subprocsOf(
  pid: number,
  childrenOf: Map<number, Proc[]>,
  candidatePids: Set<number>,
): Proc[] {
  return (childrenOf.get(pid) ?? []).flatMap((c) =>
    resolveProc(c, null, 0, childrenOf, candidatePids),
  );
}

export async function collectRows(filter: string | null): Promise<Row[]> {
  const nowMs = Date.now();
  const procs = listAllProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const sessions = readSessions();

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
  for (const p of candidates) {
    current.add(p.pid);
    for (const c of subprocsOf(p.pid, childrenOf, candidatePids))
      current.add(c.pid);
  }
  for (const pid of cpuSamples.keys()) {
    if (!current.has(pid)) cpuSamples.delete(pid);
  }

  const seenAgents = new Set<string>();
  const seenAgentDirs = new Set<string>();
  const rows = candidates.map((p): Row | null => {
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
    if (mtimeMs) {
      const cached = transcriptCache.get(transcript!);
      if (cached && cached.mtimeMs === mtimeMs) {
        details = cached.details; // unchanged since last scan
      } else {
        details = transcriptDetails(transcript!);
        transcriptCache.set(transcript!, { mtimeMs, details });
      }
    }
    const lastMs = Math.max(s?.updatedAt ?? 0, mtimeMs);
    const subagents = liveSubagents(
      mtimeMs ? transcript : null,
      nowMs,
      seenAgents,
      seenAgentDirs,
    );

    return {
      pid: p.pid,
      mem: p.rss,
      cpu: cpuPercent(p, nowMs),
      uptimeSec: p.startSec ? nowMs / 1000 - p.startSec : 0,
      startSec: p.startSec,
      state: s?.status ?? "?",
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
      transcript: mtimeMs ? transcript : null,
      subagents,
      children: subprocsOf(p.pid, childrenOf, candidatePids)
        .sort((a, b) => b.rss - a.rss || a.pid - b.pid)
        .map((c) => ({
          pid: c.pid,
          name: c.name,
          mem: c.rss,
          cpu: cpuPercent(c, nowMs),
          uptimeSec: c.startSec ? nowMs / 1000 - c.startSec : 0,
        })),
    };
  });

  // drop cached transcript details for sessions that left the table
  const liveTranscripts = new Set(
    rows.map((r) => r?.transcript).filter(Boolean),
  );
  for (const path of transcriptCache.keys()) {
    if (!liveTranscripts.has(path)) transcriptCache.delete(path);
  }
  // drop cached agent context for sub-agents that are no longer live
  for (const path of agentCache.keys()) {
    if (!seenAgents.has(path)) agentCache.delete(path);
  }

  return (rows.filter(Boolean) as Row[])
    .filter((r) => matchRow(r, filter))
    .sort(
      (a, b) =>
        (a.state === "busy" ? 0 : 1) - (b.state === "busy" ? 0 : 1) ||
        b.lastMs - a.lastMs ||
        a.pid - b.pid,
    );
}
