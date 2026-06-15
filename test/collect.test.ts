// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test, matchRow, type Row } from "../src/collect.ts";
import type { Proc } from "../src/proc.ts";

// A JSONL transcript on disk: one JSON value per line, as Claude Code writes it.
const jsonl = (entries: unknown[]) =>
  `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

// A main-thread assistant turn carrying model + token usage.
const assistant = (
  model: string,
  usage: Record<string, number>,
  content: unknown[] = [],
  extra: Record<string, unknown> = {},
) => ({
  type: "assistant",
  message: { model, usage, content },
  ...extra,
});

// A user turn; content may be a plain string or an array of blocks.
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { content },
  ...extra,
});

const row = (overrides: Partial<Row> = {}): Row => ({
  pid: 12345,
  mem: 0,
  cpu: 0,
  uptimeSec: 1,
  startSec: 1_700_000_000,
  state: "idle",
  kind: "interactive",
  sessionId: "abc-123",
  sessionName: "Release Work",
  version: "2.1.177",
  host: "Ghostty",
  project: "/Users/alice/src/cctop",
  branch: "main",
  model: "claude-sonnet-4",
  contextTokens: 10_000,
  lastActivity: null,
  lastMs: 0,
  prompt: null,
  transcript: null,
  subagents: [],
  children: [],
  ...overrides,
});

describe("collect helpers", () => {
  test("matches rows by searchable session fields", () => {
    expect(matchRow(row(), null)).toBe(true);
    expect(matchRow(row(), "cctop")).toBe(true);
    expect(matchRow(row(), "ghostty")).toBe(true);
    expect(matchRow(row(), "main")).toBe(true);
    expect(matchRow(row(), "sonnet")).toBe(true);
    expect(matchRow(row(), "abc-123")).toBe(true);
    expect(matchRow(row(), "release")).toBe(true);
    expect(matchRow(row(), "missing")).toBe(false);
  });

  test("validates well-formed session registry entries", () => {
    expect(
      __test.validSession(
        {
          pid: 12345,
          sessionId: "session-1",
          cwd: "/Users/alice/src/cctop",
          startedAt: 1_700_000_000_000,
          version: "2.1.177",
          kind: "interactive",
          status: "busy",
          updatedAt: 1_700_000_010_000,
          name: "cctop-work",
        },
        "12345.json",
      ),
    ).toEqual({
      pid: 12345,
      sessionId: "session-1",
      cwd: "/Users/alice/src/cctop",
      startedAt: 1_700_000_000_000,
      version: "2.1.177",
      kind: "interactive",
      status: "busy",
      updatedAt: 1_700_000_010_000,
      name: "cctop-work",
    });
  });

  test("rejects malformed session registry entries", () => {
    expect(__test.validSession({ pid: 12345 }, "12345.json")).toBeNull();
    expect(
      __test.validSession(
        {
          pid: 99999,
          sessionId: "session-1",
          cwd: "/tmp/project",
          startedAt: 1_700_000_000_000,
        },
        "12345.json",
      ),
    ).toBeNull();
    expect(
      __test.validSession(
        {
          pid: 12345,
          sessionId: "",
          cwd: "/tmp/project",
          startedAt: 1_700_000_000_000,
        },
        "12345.json",
      ),
    ).toBeNull();
    expect(
      __test.validSession(
        {
          pid: 12345,
          sessionId: "session-1",
          cwd: "/tmp/project",
          startedAt: Number.NaN,
        },
        "12345.json",
      ),
    ).toBeNull();
  });

  test("normalizes optional session registry fields", () => {
    expect(
      __test.validSession(
        {
          pid: 12345,
          sessionId: "session-1",
          cwd: "/tmp/project",
          startedAt: 1_700_000_000_000,
          version: 2,
          kind: null,
          status: false,
          updatedAt: "now",
          name: "valid name",
        },
        "12345.json",
      ),
    ).toEqual({
      pid: 12345,
      sessionId: "session-1",
      cwd: "/tmp/project",
      startedAt: 1_700_000_000_000,
      version: undefined,
      kind: undefined,
      status: undefined,
      updatedAt: undefined,
      name: "valid name",
    });
  });
});

// noteEntry folds one transcript entry into the running Details. The scan runs
// backwards from the tail, so the first entry that supplies a field wins —
// i.e. the newest one. These are the fields most exposed to schema drift.
describe("transcript entry parsing", () => {
  test("reads model and sums context tokens from an assistant turn", () => {
    const d: { model?: string; ctx?: number } = {};
    __test.noteEntry(
      d,
      assistant("claude-sonnet-4", {
        input_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 50,
        output_tokens: 999, // not part of context
      }),
    );
    expect(d.model).toBe("claude-sonnet-4");
    expect(d.ctx).toBe(2150);
  });

  test("tolerates missing token sub-fields", () => {
    const d: { ctx?: number } = {};
    __test.noteEntry(d, assistant("claude-sonnet-4", { input_tokens: 7 }));
    expect(d.ctx).toBe(7);
  });

  test("skips synthetic, sidechain, and usage-less assistant turns", () => {
    const synthetic: { model?: string } = {};
    __test.noteEntry(synthetic, assistant("<synthetic>", { input_tokens: 1 }));
    expect(synthetic.model).toBeUndefined();

    const sidechain: { model?: string } = {};
    __test.noteEntry(
      sidechain,
      assistant("claude-sonnet-4", { input_tokens: 1 }, [], {
        isSidechain: true,
      }),
    );
    expect(sidechain.model).toBeUndefined();

    const noUsage: { model?: string } = {};
    __test.noteEntry(noUsage, {
      type: "assistant",
      message: { model: "claude-sonnet-4", content: [] },
    });
    expect(noUsage.model).toBeUndefined();
  });

  test("keeps the first model seen (newest, scanning backwards)", () => {
    const d: { model?: string } = {};
    __test.noteEntry(d, assistant("claude-opus-4", { input_tokens: 1 }));
    __test.noteEntry(d, assistant("claude-sonnet-4", { input_tokens: 1 }));
    expect(d.model).toBe("claude-opus-4");
  });

  test("extracts the last prompt from string and block content", () => {
    const fromString: { prompt?: string } = {};
    __test.noteEntry(fromString, user("  fix   the   bug\n"));
    expect(fromString.prompt).toBe("fix the bug");

    const fromBlocks: { prompt?: string } = {};
    __test.noteEntry(
      fromBlocks,
      user([{ type: "image" }, { type: "text", text: "describe this" }]),
    );
    expect(fromBlocks.prompt).toBe("describe this");
  });

  test("unwraps slash-command prompts and drops harness wrappers", () => {
    const slash: { prompt?: string } = {};
    __test.noteEntry(
      slash,
      user(
        "<command-name>/compact</command-name><command-args>now</command-args>",
      ),
    );
    expect(slash.prompt).toBe("/compact now");

    const wrapper: { prompt?: string } = {};
    __test.noteEntry(
      wrapper,
      user("<local-command-stdout>build ok</local-command-stdout>"),
    );
    expect(wrapper.prompt).toBeUndefined();
  });

  test("ignores meta and sidechain user turns for the prompt", () => {
    const meta: { prompt?: string } = {};
    __test.noteEntry(meta, user("system note", { isMeta: true }));
    expect(meta.prompt).toBeUndefined();

    const side: { prompt?: string } = {};
    __test.noteEntry(side, user("agent prompt", { isSidechain: true }));
    expect(side.prompt).toBeUndefined();
  });

  test("reads git branch and signals completion once all fields are set", () => {
    const d: Record<string, unknown> = {};
    expect(
      __test.noteEntry(
        d,
        assistant("claude-sonnet-4", { input_tokens: 1 }, [], {
          gitBranch: "main",
        }),
      ),
    ).toBe(false); // model + branch, but no prompt yet
    expect(d.branch).toBe("main");
    expect(__test.noteEntry(d, user("do the thing"))).toBe(true);
  });
});

// describeAssistant turns the latest assistant turn into the agent's activity
// label: its most recent tool call (tool + key arg) or a text snippet.
describe("agent activity description", () => {
  const describe_ = __test.describeAssistant;

  test("labels the most recent tool call with its key argument", () => {
    expect(
      describe_({
        content: [
          { type: "text", text: "thinking" },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "go test ./..." },
          },
        ],
      }),
    ).toBe("Bash: go test ./...");
  });

  test("prefers the last tool_use when several are present", () => {
    expect(
      describe_({
        content: [
          { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
          { type: "tool_use", name: "Read", input: { file_path: "/a/b/c.ts" } },
        ],
      }),
    ).toBe("Read: c.ts");
  });

  test("falls back through the recognized argument keys", () => {
    expect(
      describe_({
        content: [{ type: "tool_use", name: "X", input: { query: "q" } }],
      }),
    ).toBe("X: q");
    expect(
      describe_({
        content: [{ type: "tool_use", name: "X", input: { url: "u" } }],
      }),
    ).toBe("X: u");
    expect(
      describe_({ content: [{ type: "tool_use", name: "X", input: {} }] }),
    ).toBe("X");
  });

  test("uses a text snippet when there is no tool call", () => {
    expect(
      describe_({ content: [{ type: "text", text: "  just   talking  " }] }),
    ).toBe("just talking");
  });

  test("returns null for empty or malformed content", () => {
    expect(describe_({})).toBeNull();
    expect(describe_({ content: "oops" })).toBeNull();
    expect(describe_(null)).toBeNull();
  });
});

// transcriptDetails and agentContext scan a real file from the tail, so they're
// exercised against temp transcripts — including one larger than a single read
// chunk to cover the backward multi-chunk path.
describe("transcript file scanning", () => {
  let dir: string;
  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cctop-test-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns empty details for missing or empty files", () => {
    expect(__test.transcriptDetails(join(dir, "nope.jsonl"))).toEqual({});
    expect(__test.transcriptDetails(write("empty.jsonl", ""))).toEqual({});
  });

  test("pulls model, context, branch, and prompt from a transcript", () => {
    const path = write(
      "session.jsonl",
      jsonl([
        user("first prompt", { isMeta: true }),
        user("please refactor collect.ts"),
        assistant(
          "claude-sonnet-4",
          { input_tokens: 10, cache_read_input_tokens: 1000 },
          [{ type: "text", text: "on it" }],
          { gitBranch: "feature/parse" },
        ),
      ]),
    );
    expect(__test.transcriptDetails(path)).toEqual({
      model: "claude-sonnet-4",
      ctx: 1010,
      branch: "feature/parse",
      prompt: "please refactor collect.ts",
    });
  });

  test("skips a half-written final line instead of throwing", () => {
    const path = write(
      "partial.jsonl",
      `${JSON.stringify(user("the prompt"))}\n${JSON.stringify(
        assistant("claude-sonnet-4", { input_tokens: 5 }, [], {
          gitBranch: "main",
        }),
      )}\n{"type":"assistant","message":{"mod`, // truncated append
    );
    const d = __test.transcriptDetails(path);
    expect(d.model).toBe("claude-sonnet-4");
    expect(d.prompt).toBe("the prompt");
    expect(d.branch).toBe("main");
  });

  test("scans backwards across read chunks for a far-back prompt", () => {
    // The prompt sits at the very top; padding after it exceeds one read chunk
    // (256 KiB), so finding it requires walking back through multiple chunks.
    const filler = "x".repeat(1024);
    const lines: unknown[] = [user("the very first prompt")];
    for (let i = 0; i < 400; i++) {
      lines.push(user(filler, { isMeta: true })); // ignored: meta
    }
    lines.push(
      assistant("claude-opus-4", { input_tokens: 42 }, [], {
        gitBranch: "main",
      }),
    );
    const path = write("big.jsonl", jsonl(lines));
    const d = __test.transcriptDetails(path);
    expect(d.model).toBe("claude-opus-4");
    expect(d.branch).toBe("main");
    expect(d.prompt).toBe("the very first prompt");
  });

  test("reassembles a single line longer than two read chunks", () => {
    // One assistant turn ~700 KiB — wider than two 256 KiB chunks — so the
    // backward scan hits a chunk with no newline at all and must carry the
    // whole block forward until the line is reassembled at the file start.
    const huge = "y".repeat(700 * 1024);
    const path = write(
      "huge-line.jsonl",
      jsonl([
        user("small far-back prompt"),
        assistant(
          "claude-opus-4",
          { input_tokens: 9 },
          [{ type: "text", text: huge }],
          { gitBranch: "main" },
        ),
      ]),
    );
    const d = __test.transcriptDetails(path);
    expect(d.model).toBe("claude-opus-4");
    expect(d.branch).toBe("main");
    expect(d.prompt).toBe("small far-back prompt");
  });

  test("reads agent model, context, activity, and running state", () => {
    const path = write(
      "agent-1.jsonl",
      jsonl([
        assistant(
          "claude-haiku-4",
          { input_tokens: 8, cache_creation_input_tokens: 200 },
          [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
        ),
        user([{ type: "tool_result", content: "..." }]),
      ]),
    );
    const ctx = __test.agentContext(path);
    expect(ctx.model).toBe("claude-haiku-4");
    expect(ctx.ctx).toBe(208);
    expect(ctx.activity).toBe("Bash: ls -la");
    expect(ctx.running).toBe(true); // last turn is a tool_result, awaiting next
  });

  test("treats a text-only final assistant turn as not running", () => {
    const path = write(
      "agent-2.jsonl",
      jsonl([
        assistant("claude-haiku-4", { input_tokens: 8 }, [
          { type: "text", text: "all done" },
        ]),
      ]),
    );
    const ctx = __test.agentContext(path);
    expect(ctx.activity).toBe("all done");
    expect(ctx.running).toBe(false);
  });
});

// liveSubagents decides which sub-agent transcripts count as running, from
// their on-disk mtime: written very recently (< 20s) is live; quiet but
// mid-tool-call (< 180s) is live; quiet and finished is done; past 180s is
// gone. Backed by temp agent files whose mtimes we set explicitly.
describe("sub-agent liveness", () => {
  let dir: string;
  const now = 1_700_000_000_000; // fixed clock; mtimes are set relative to it

  // Write an agent transcript and stamp its mtime `ageMs` before `now`.
  const agentFile = (name: string, ageMs: number, entries: unknown[]) => {
    const subdir = join(dir, "session", "subagents");
    mkdirSync(subdir, { recursive: true });
    const path = join(subdir, name);
    writeFileSync(path, jsonl(entries));
    const t = new Date(now - ageMs);
    utimesSync(path, t, t);
    return path;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cctop-agents-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = () => join(dir, "session.jsonl");
  const toolTurn = (cmd: string) =>
    assistant("claude-haiku-4", { input_tokens: 5 }, [
      { type: "tool_use", name: "Bash", input: { command: cmd } },
    ]);
  const textTurn = (text: string) =>
    assistant("claude-haiku-4", { input_tokens: 5 }, [{ type: "text", text }]);

  test("includes fresh and mid-tool-call agents, drops the rest", () => {
    // fresh: quiet only 5s, finished — live anyway (inside the 20s window)
    agentFile("agent-fresh.jsonl", 5_000, [
      assistant("claude-opus-4", { input_tokens: 900 }, [
        { type: "text", text: "wrapped up" },
      ]),
    ]);
    // busy: quiet 60s but last turn is a tool call awaiting its result — live
    agentFile("agent-busy.jsonl", 60_000, [toolTurn("go test ./...")]);
    // quiet: 60s and finished (text-only) — past the live window, dropped
    agentFile("agent-quiet.jsonl", 60_000, [textTurn("done thinking")]);
    // gone: 300s — past the 180s busy cap, dropped before the running check
    agentFile("agent-gone.jsonl", 300_000, [toolTurn("sleep 1")]);

    const seen = new Set<string>();
    const agents = __test.liveSubagents(transcript(), now, seen, new Set());

    // only the fresh (ctx 900) and busy (ctx 5) agents survive, ctx-sorted
    expect(agents.map((a) => a.model)).toEqual([
      "claude-opus-4",
      "claude-haiku-4",
    ]);
    expect(agents.map((a) => a.activity)).toEqual([
      "wrapped up",
      "Bash: go test ./...",
    ]);
    // fresh, busy, and quiet are all within the busy cap, so all three are
    // marked seen (cache retention); only the 300s-gone agent is excluded
    expect(seen.size).toBe(3);
  });

  test("lists a subagents directory only once across sessions", () => {
    agentFile("agent-dup.jsonl", 1_000, [textTurn("hi")]);
    const seenDirs = new Set<string>();
    expect(
      __test.liveSubagents(transcript(), now, new Set(), seenDirs).length,
    ).toBeGreaterThan(0);
    // a second session falling back to the same transcript sees nothing
    expect(
      __test.liveSubagents(transcript(), now, new Set(), seenDirs),
    ).toEqual([]);
  });

  test("returns nothing without a transcript", () => {
    expect(__test.liveSubagents(null, now, new Set(), new Set())).toEqual([]);
  });
});

// hostApp walks a process's ancestry past shells and wrappers to the program
// that hosts the session: an app bundle, tmux, ssh, or the first real command.
describe("host resolution", () => {
  const proc = (over: Partial<Proc>): Proc => ({
    pid: 0,
    ppid: 0,
    rss: 0,
    cpuSec: 0,
    startSec: 0,
    path: null,
    name: "claude",
    ...over,
  });
  const tree = (procs: Proc[]) => new Map(procs.map((p) => [p.pid, p]));

  test("resolves a macOS app bundle ancestor", () => {
    const claude = proc({ pid: 10, ppid: 11 });
    const shell = proc({ pid: 11, ppid: 12, name: "zsh" });
    const term = proc({
      pid: 12,
      ppid: 1,
      name: "Ghostty",
      path: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    });
    expect(__test.hostApp(claude, tree([claude, shell, term]))).toBe("Ghostty");
  });

  test("recognizes tmux and ssh by process name", () => {
    const claude = proc({ pid: 20, ppid: 21 });
    const tmux = proc({ pid: 21, ppid: 1, name: "tmux: server" });
    expect(__test.hostApp(claude, tree([claude, tmux]))).toBe("tmux");

    const claude2 = proc({ pid: 30, ppid: 31 });
    const sshd = proc({ pid: 31, ppid: 1, name: "sshd-session" });
    expect(__test.hostApp(claude2, tree([claude2, sshd]))).toBe("ssh");
  });

  test("skips known wrappers and stops at the first real program", () => {
    const claude = proc({ pid: 40, ppid: 41 });
    const sh = proc({ pid: 41, ppid: 42, name: "bash" });
    const env = proc({ pid: 42, ppid: 43, name: "env" });
    const node = proc({ pid: 43, ppid: 1, name: "node" });
    expect(__test.hostApp(claude, tree([claude, sh, env, node]))).toBe("node");
  });

  test("returns '?' when the ancestry runs out", () => {
    const orphan = proc({ pid: 50, ppid: 1 });
    expect(__test.hostApp(orphan, tree([orphan]))).toBe("?");
  });

  // A bg job / sub-session is hosted by the Claude that spawned it; the parent
  // carries the versioned exec name ("2.1.177"), which must read as "claude"
  // rather than leak the version into the HOST column.
  test("reports a nested Claude parent as 'claude'", () => {
    const child = proc({ pid: 60, ppid: 61 });
    const parent = proc({
      pid: 61,
      ppid: 1,
      name: "2.1.177",
      path: "/u/claude/versions/2.1.177",
    });
    expect(__test.hostApp(child, tree([child, parent]))).toBe("claude");
  });
});

// subprocsOf walks a session's children into the sub-process rows shown beneath
// it: descending through wrapping shells to the real tool command, dropping idle
// shells, and excluding nested Claude sessions (which get their own top-level
// row, so their versioned exec name must never appear as a child).
describe("sub-process resolution", () => {
  const proc = (over: Partial<Proc>): Proc => ({
    pid: 0,
    ppid: 0,
    rss: 0,
    cpuSec: 0,
    startSec: 0,
    path: null,
    name: "node",
    ...over,
  });
  // build the parent->children index the same way collectRows does
  const childrenOf = (procs: Proc[]) => __test.indexChildren(procs);

  test("excludes a nested Claude and does not bubble up its children", () => {
    const session = proc({ pid: 100, name: "claude" });
    const nested = proc({
      pid: 101,
      ppid: 100,
      name: "2.1.177",
      path: "/u/claude/versions/2.1.177",
    });
    const tool = proc({ pid: 102, ppid: 101, name: "go" });
    const idx = childrenOf([session, nested, tool]);

    // the nested Claude is dropped from its parent's tree, and its own tool
    // child stays with it (it does NOT re-parent onto the session)
    expect(__test.subprocsOf(100, idx)).toEqual([]);
    // the nested Claude lists its own sub-processes on its own row
    expect(__test.subprocsOf(101, idx).map((p) => p.name)).toEqual(["go"]);
  });

  test("descends a wrapping shell to the real command with a single prefix", () => {
    const session = proc({ pid: 200, name: "claude" });
    const shell = proc({ pid: 201, ppid: 200, name: "bash" });
    const cmd = proc({ pid: 202, ppid: 201, name: "go" });
    const idx = childrenOf([session, shell, cmd]);
    expect(__test.subprocsOf(200, idx).map((p) => p.name)).toEqual(["bash › go"]);
  });

  test("drops an idle childless shell but keeps a real direct command", () => {
    const session = proc({ pid: 300, name: "claude" });
    const idleShell = proc({ pid: 301, ppid: 300, name: "zsh" });
    const direct = proc({ pid: 302, ppid: 300, name: "mcp-server" });
    const idx = childrenOf([session, idleShell, direct]);
    expect(__test.subprocsOf(300, idx).map((p) => p.name)).toEqual([
      "mcp-server",
    ]);
  });
});

// cpuPercent is top-style: the delta between two samples once it has a prior,
// or the lifetime average on the first sample. PID reuse can make the counter
// go backwards, which must clamp to 0 rather than report a negative spike.
describe("cpu sampling", () => {
  const proc = (pid: number, cpuSec: number, startSec: number): Proc => ({
    pid,
    ppid: 1,
    rss: 0,
    cpuSec,
    startSec,
    path: null,
    name: "claude",
  });

  test("first sample is the lifetime average", () => {
    const now = 1_700_000_000_000;
    // 5 CPU-seconds over a 10s lifetime -> 50%
    const cpu = __test.cpuPercent(proc(60_001, 5, now / 1000 - 10), now);
    expect(cpu).toBeCloseTo(50, 5);
  });

  test("second sample is the delta against the previous", () => {
    const pid = 60_002;
    const t0 = 1_700_000_000_000;
    __test.cpuPercent(proc(pid, 0, t0 / 1000 - 100), t0); // seed
    // +1 CPU-second over a 2s wall-clock gap -> 50%
    const cpu = __test.cpuPercent(proc(pid, 1, t0 / 1000 - 100), t0 + 2000);
    expect(cpu).toBeCloseTo(50, 5);
  });

  test("clamps a backwards counter (PID reuse) to zero", () => {
    const pid = 60_003;
    const t0 = 1_700_000_000_000;
    __test.cpuPercent(proc(pid, 50, t0 / 1000 - 100), t0); // seed high
    // the PID is reused: cpuSec resets lower, so the delta is negative
    const cpu = __test.cpuPercent(proc(pid, 1, t0 / 1000 - 1), t0 + 2000);
    expect(cpu).toBe(0);
  });
});

// Identifying a Claude Code process and reading its version out of the
// version-named executable path (.../claude/versions/2.1.176).
describe("claude process identification", () => {
  const proc = (name: string, path: string | null): Proc => ({
    pid: 1,
    ppid: 1,
    rss: 0,
    cpuSec: 0,
    startSec: 0,
    path,
    name,
  });

  test("matches by name or a versioned executable path", () => {
    expect(__test.isClaudeProc(proc("claude", null))).toBe(true);
    expect(
      __test.isClaudeProc(proc("2.1.176", "/u/claude/versions/2.1.176")),
    ).toBe(true);
    expect(__test.isClaudeProc(proc("node", "/usr/bin/node"))).toBe(false);
    expect(__test.isClaudeProc(proc("bash", null))).toBe(false);
  });

  test("reads the version from the executable's last path segment", () => {
    expect(__test.versionFromPath("/u/claude/versions/2.1.176")).toBe(
      "2.1.176",
    );
    expect(__test.versionFromPath("/u/claude/versions/2.1")).toBe("2.1");
    expect(__test.versionFromPath("/usr/local/bin/claude")).toBeNull();
    expect(__test.versionFromPath(null)).toBeNull();
  });
});
