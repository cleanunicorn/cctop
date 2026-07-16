// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Codex rollout transcript parsing. A rollout is JSONL, one record per line,
// each an envelope `{ timestamp, type, payload }` where type is one of
// session_meta (first line, immutable), turn_context, response_item, or
// event_msg. Two reads are needed: the head yields the immutable session_meta
// (cwd, id, branch, cli version, start), and the tail yields the newest model,
// context size, last prompt, last turn, and whether a turn is in flight.
//
// Read-only, defensive: the rollout schema is undocumented and versions between
// codex releases, so every field is optional and a malformed/half-written line
// is skipped, never thrown — the same contract as the Claude transcript reader.
// The exact field paths below should be validated against a real codex install.

import { truncate } from "../../format.ts";
import type { Details } from "../transcript.ts";
import { scanTailEntries } from "../transcript.ts";

// The last prompt is a preview, not a faithful copy; cap it like the Claude
// reader (PROMPT_MAX there) so a pasted blob can't bloat the row.
const PROMPT_MAX = 2048;

// The immutable session header (rollout's first line). cwd + id disambiguate a
// rollout from a running codex pid; branch/cliVersion fill row columns the tail
// scan can't see (session_meta sits at the head, far from a long rollout's tail).
export interface SessionMeta {
  cwd: string | null;
  sessionId: string | null;
  startMs: number | null; // session start (RFC3339 timestamp), unix ms
  branch: string | null;
  cliVersion: string | null;
}

// Reads at most this many bytes from the head looking for session_meta; it is
// the first line, so a small window is plenty even with a large instructions blob.
const HEAD_BYTES = 128 * 1024;

// session_meta is written once as the first line and never rewritten, so a
// successful parse is cached permanently (pruned only when the file disappears).
const metaCache = new Map<string, SessionMeta>();

export async function sessionMeta(path: string): Promise<SessionMeta | null> {
  const cached = metaCache.get(path);
  if (cached) return cached;
  let meta: SessionMeta | null = null;
  try {
    const head = Buffer.from(
      await Bun.file(path).slice(0, HEAD_BYTES).bytes(),
    ).toString("utf8");
    for (const line of head.split("\n")) {
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // half-written or a boundary-split first line
      }
      const p = e?.payload;
      if (e?.type === "session_meta" && p) {
        const startMs = Date.parse(p.timestamp ?? e.timestamp);
        meta = {
          cwd: typeof p.cwd === "string" ? p.cwd : null,
          sessionId: typeof p.id === "string" ? p.id : null,
          startMs: Number.isNaN(startMs) ? null : startMs,
          branch: typeof p.git?.branch === "string" ? p.git.branch : null,
          cliVersion: typeof p.cli_version === "string" ? p.cli_version : null,
        };
        break;
      }
    }
  } catch {
    // gone or unreadable
  }
  // cache only a real header; a missing one may just be a not-yet-flushed file,
  // so leave it uncached to retry next refresh
  if (meta) metaCache.set(path, meta);
  return meta;
}

// The tail-derived, mutable half of a rollout: the newest model + context size,
// the last user prompt, the action of the last turn, and a liveness flag. Branch
// comes from session_meta (head), so it is not repeated here.
export interface RolloutDetails {
  model?: string;
  ctx?: number;
  prompt?: string;
  promptAt?: number;
  lastTurn?: string;
  running: boolean; // the last record indicates a turn still in flight
}

// The pull-out text of a message's content: codex content is an array of blocks
// carrying `text` (input_text / output_text), or occasionally a bare string.
function messageText(content: any): string | null {
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
      .join(" ");
  if (!text) return null;
  text = text.replace(/\s+/g, " ").trim();
  // codex injects context/instruction blocks as user messages wrapped in XML
  // tags (<environment_context>, <user_instructions>, …); skip those so the
  // row shows the actual request, mirroring the Claude reader's `<`-wrapper skip
  return text && !text.startsWith("<") ? text : null;
}

// Context window occupied, from an event_msg token_count `info`. codex reports
// per-turn `last_token_usage` (preferred — tracks the live window) and cumulative
// `total_token_usage` (the session total, which would balloon past the window).
// `input_tokens` is the full prompt size the last request carried, i.e. what the
// context currently holds — the codex analogue of the Claude CTX column.
function contextFromInfo(info: any): number | undefined {
  const u = info?.last_token_usage ?? info?.total_token_usage;
  if (!u) return undefined;
  const n = Number(u.input_tokens ?? u.total_tokens);
  return Number.isFinite(n) ? n : undefined;
}

// A one-line label for a tool call the last turn issued: the tool name plus its
// most telling argument (the shell command, or a path/pattern/query), mirroring
// describeAssistant for the Claude side.
function toolLabel(p: any): string {
  const name =
    typeof p?.name === "string"
      ? p.name
      : p?.type === "local_shell_call"
        ? "shell"
        : "tool";
  let arg = "";
  try {
    const a =
      typeof p?.arguments === "string" ? JSON.parse(p.arguments) : p?.arguments;
    const cmd = a?.command ?? a?.cmd ?? p?.action?.command;
    if (Array.isArray(cmd)) arg = cmd.join(" ");
    else if (typeof cmd === "string") arg = cmd;
    else arg = String(a?.path ?? a?.file_path ?? a?.pattern ?? a?.query ?? "");
  } catch {
    // unparseable arguments — fall back to just the tool name
  }
  arg = arg.replace(/\s+/g, " ").trim().slice(0, 120);
  return arg ? `${name}: ${arg}` : name;
}

// Whether a record indicates a turn still in flight. Evaluated only on the
// rollout's last line (see rolloutDetails): a tool call awaiting its output, a
// tool output awaiting the next model turn, a freshly submitted user prompt, or
// a started-but-not-completed task all mean busy; a completed assistant turn,
// task_complete, or a trailing token_count mean the mtime window alone governs.
const IN_FLIGHT_ITEMS = new Set([
  "function_call",
  "function_call_output",
  "local_shell_call",
  "custom_tool_call",
  "custom_tool_call_output",
]);
function inFlight(e: any): boolean {
  const p = e?.payload;
  if (e?.type === "response_item") {
    if (IN_FLIGHT_ITEMS.has(p?.type)) return true;
    return p?.type === "message" && p?.role === "user";
  }
  if (e?.type === "event_msg") return p?.type === "task_started";
  return false;
}

// Scan a rollout tail for its mutable details, newest-first, stopping once model
// + ctx + prompt + lastTurn are all known. `running` is decided from the very
// last record (the first one this backward scan sees).
export async function rolloutDetails(path: string): Promise<RolloutDetails> {
  const d: RolloutDetails = { running: false };
  let sawLast = false;
  await scanTailEntries(path, (e) => {
    if (!sawLast) {
      sawLast = true;
      d.running = inFlight(e);
    }
    const p = e?.payload;
    if (e?.type === "turn_context") {
      if (!d.model && typeof p?.model === "string") d.model = p.model;
    } else if (e?.type === "event_msg") {
      if (d.ctx === undefined && p?.type === "token_count") {
        const c = contextFromInfo(p.info);
        if (c !== undefined) d.ctx = c;
      }
    } else if (e?.type === "response_item") {
      if (p?.type === "message") {
        if (p.role === "user" && !d.prompt) {
          const text = messageText(p.content);
          if (text) {
            d.prompt = truncate(text, PROMPT_MAX);
            const t = Date.parse(e.timestamp);
            if (!Number.isNaN(t)) d.promptAt = t;
          }
        } else if (p.role === "assistant" && !d.lastTurn) {
          const text = messageText(p.content);
          if (text) d.lastTurn = text;
        }
      } else if (
        !d.lastTurn &&
        (p?.type === "function_call" || p?.type === "local_shell_call")
      ) {
        d.lastTurn = toolLabel(p);
      }
    }
    return Boolean(d.model && d.ctx !== undefined && d.prompt && d.lastTurn);
  });
  return d;
}

// rolloutDetails served from a cache while the file's mtime is unchanged, so an
// idle codex session is not re-scanned every refresh (mirrors the Claude reader).
const detailsCache = new Map<
  string,
  { mtimeMs: number; details: RolloutDetails }
>();

export async function rolloutDetailsCached(
  path: string,
  mtimeMs: number,
): Promise<RolloutDetails> {
  const cached = detailsCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.details;
  const details = await rolloutDetails(path);
  detailsCache.set(path, { mtimeMs, details });
  return details;
}

// Merge a rollout's immutable meta and mutable details into the shared Details
// shape the row assembler consumes (branch from meta, the rest from the tail).
export function toDetails(
  meta: SessionMeta | null,
  rd: RolloutDetails,
): Details {
  return {
    branch: meta?.branch ?? undefined,
    model: rd.model,
    ctx: rd.ctx,
    prompt: rd.prompt,
    promptAt: rd.promptAt,
    lastTurn: rd.lastTurn,
  };
}

// Codex writes no busy/idle status (Claude has a per-pid registry that does), so
// state is inferred like a live sub-agent: a two-window blend of "wrote a turn
// this recently" (LIVE) and "quiet but mid tool-call" (BUSY, needs the in-flight
// grammar). Limits: it cannot see codex's "waiting for user approval" state
// (indistinguishable from idle), and a slow model turn between writes can read
// as a brief false idle. An unclassifiable rollout degrades to idle here (and to
// "?" upstream when nothing at all resolved).
const CODEX_LIVE_MS = 20_000; // wrote a record this recently ⇒ busy
const CODEX_BUSY_MS = 180_000; // quiet but a tool call is outstanding ⇒ busy

export function codexState(
  running: boolean,
  mtimeMs: number,
  nowMs: number,
): string {
  const age = nowMs - mtimeMs;
  return age <= CODEX_LIVE_MS || (running && age <= CODEX_BUSY_MS)
    ? "busy"
    : "idle";
}

// Drop cached meta/details for rollouts that are no longer live, so the maps do
// not grow without bound. `keep` is the set of still-live rollout paths.
export function pruneCodexTranscriptCaches(keep: Set<string>) {
  for (const path of metaCache.keys())
    if (!keep.has(path)) metaCache.delete(path);
  for (const path of detailsCache.keys())
    if (!keep.has(path)) detailsCache.delete(path);
}
