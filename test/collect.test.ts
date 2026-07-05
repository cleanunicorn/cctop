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
import {
  __test,
  captureUsage,
  type Instance,
  matchRow,
} from "../src/collect.ts";
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

const row = (overrides: Partial<Instance> = {}): Instance => ({
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
  promptAt: null,
  lastTurn: null,
  transcript: null,
  subagents: [],
  children: [],
  orphanPorts: [],
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

  test("returns empty details for missing or empty files", async () => {
    expect(await __test.transcriptDetails(join(dir, "nope.jsonl"))).toEqual({});
    expect(await __test.transcriptDetails(write("empty.jsonl", ""))).toEqual(
      {},
    );
  });

  test("pulls model, context, branch, and prompt from a transcript", async () => {
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
    expect(await __test.transcriptDetails(path)).toEqual({
      model: "claude-sonnet-4",
      ctx: 1010,
      branch: "feature/parse",
      prompt: "please refactor collect.ts",
      lastTurn: "on it",
    });
  });

  test("last turn reports the most recent turn's tool call", async () => {
    const path = write(
      "tool-turn.jsonl",
      jsonl([
        user("go"),
        assistant(
          "claude-sonnet-4",
          { input_tokens: 5 },
          [{ type: "tool_use", name: "Edit", input: { file_path: "a/b.ts" } }],
          { gitBranch: "main" },
        ),
      ]),
    );
    expect((await __test.transcriptDetails(path)).lastTurn).toBe("Edit: b.ts");
  });

  test("captures the last prompt's timestamp", async () => {
    const at = "2026-06-17T12:00:00.000Z";
    const path = write(
      "prompt-ts.jsonl",
      jsonl([
        user("the prompt", { timestamp: at }),
        assistant("claude-sonnet-4", { input_tokens: 5 }, [], {
          gitBranch: "main",
        }),
      ]),
    );
    expect((await __test.transcriptDetails(path)).promptAt).toBe(
      Date.parse(at),
    );
  });

  test("skips a half-written final line instead of throwing", async () => {
    const path = write(
      "partial.jsonl",
      `${JSON.stringify(user("the prompt"))}\n${JSON.stringify(
        assistant("claude-sonnet-4", { input_tokens: 5 }, [], {
          gitBranch: "main",
        }),
      )}\n{"type":"assistant","message":{"mod`, // truncated append
    );
    const d = await __test.transcriptDetails(path);
    expect(d.model).toBe("claude-sonnet-4");
    expect(d.prompt).toBe("the prompt");
    expect(d.branch).toBe("main");
  });

  test("scans backwards across read chunks for a far-back prompt", async () => {
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
    const d = await __test.transcriptDetails(path);
    expect(d.model).toBe("claude-opus-4");
    expect(d.branch).toBe("main");
    expect(d.prompt).toBe("the very first prompt");
  });

  test("reassembles a single line longer than two read chunks", async () => {
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
    const d = await __test.transcriptDetails(path);
    expect(d.model).toBe("claude-opus-4");
    expect(d.branch).toBe("main");
    expect(d.prompt).toBe("small far-back prompt");
  });

  test("reads agent model, context, activity, and running state", async () => {
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
    const ctx = await __test.agentContext(path);
    expect(ctx.model).toBe("claude-haiku-4");
    expect(ctx.ctx).toBe(208);
    expect(ctx.activity).toBe("Bash: ls -la");
    expect(ctx.running).toBe(true); // last turn is a tool_result, awaiting next
  });

  test("treats a text-only final assistant turn as not running", async () => {
    const path = write(
      "agent-2.jsonl",
      jsonl([
        assistant("claude-haiku-4", { input_tokens: 8 }, [
          { type: "text", text: "all done" },
        ]),
      ]),
    );
    const ctx = await __test.agentContext(path);
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

  test("includes fresh and mid-tool-call agents, drops the rest", async () => {
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
    const agents = await __test.liveSubagents(
      transcript(),
      now,
      seen,
      new Set(),
    );

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

  test("lists a subagents directory only once across sessions", async () => {
    agentFile("agent-dup.jsonl", 1_000, [textTurn("hi")]);
    const seenDirs = new Set<string>();
    expect(
      (await __test.liveSubagents(transcript(), now, new Set(), seenDirs))
        .length,
    ).toBeGreaterThan(0);
    // a second session falling back to the same transcript sees nothing
    expect(
      await __test.liveSubagents(transcript(), now, new Set(), seenDirs),
    ).toEqual([]);
  });

  test("attaches shared subagents to the first row in row-base order", async () => {
    const transcriptPath = join(dir, "ordered.jsonl");
    const subdir = join(dir, "ordered", "subagents");
    mkdirSync(subdir, { recursive: true });
    const agentPath = join(subdir, "agent-ordered.jsonl");
    writeFileSync(agentPath, jsonl([textTurn("owned")]));
    const t = new Date(now - 1_000);
    utimesSync(agentPath, t, t);

    const seen = new Set<string>();
    const rows = await __test.attachSubagentsInOrder(
      [
        row({ pid: 200, transcript: transcriptPath }),
        row({ pid: 100, transcript: transcriptPath }),
      ],
      now,
      seen,
    );

    expect(rows.map((r) => [r.pid, r.subagents.length])).toEqual([
      [200, 1],
      [100, 0],
    ]);
    expect(rows[0]?.subagents[0]?.activity).toBe("owned");
    expect(seen.has(agentPath)).toBe(true);
  });

  test("returns nothing without a transcript", async () => {
    expect(await __test.liveSubagents(null, now, new Set(), new Set())).toEqual(
      [],
    );
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
  test("reports a nested Claude parent (versioned path) as 'claude'", () => {
    const child = proc({ pid: 60, ppid: 61 });
    const parent = proc({
      pid: 61,
      ppid: 1,
      name: "2.1.177",
      path: "/u/claude/versions/2.1.177",
    });
    expect(__test.hostApp(child, tree([child, parent]))).toBe("claude");
  });

  // the other isClaudeProc branch: a normally-launched parent Claude is named
  // "claude" with no versioned path — the common nesting case
  test("reports a nested Claude parent (named 'claude') as 'claude'", () => {
    const child = proc({ pid: 70, ppid: 71 });
    const parent = proc({ pid: 71, ppid: 1, name: "claude", path: null });
    expect(__test.hostApp(child, tree([child, parent]))).toBe("claude");
  });

  // ordering the fix depends on: the Claude check sits AFTER the .app bundle
  // match, so a nearer terminal bundle still wins over a Claude further up.
  test("a nearer app bundle wins over a Claude ancestor above it", () => {
    const child = proc({ pid: 80, ppid: 81 });
    const term = proc({
      pid: 81,
      ppid: 82,
      name: "Ghostty",
      path: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    });
    const claudeAbove = proc({
      pid: 82,
      ppid: 1,
      name: "2.1.177",
      path: "/u/claude/versions/2.1.177",
    });
    expect(__test.hostApp(child, tree([child, term, claudeAbove]))).toBe(
      "Ghostty",
    );
  });

  // ...but the Claude check sits BEFORE the first-real-program fallback, so a
  // Claude ancestor short-circuits and is never shadowed by a deeper program
  test("a Claude ancestor short-circuits before a deeper program", () => {
    const child = proc({ pid: 90, ppid: 91 });
    const shell = proc({ pid: 91, ppid: 92, name: "zsh" });
    const claudeParent = proc({
      pid: 92,
      ppid: 93,
      name: "2.1.177",
      path: "/u/claude/versions/2.1.177",
    });
    const node = proc({ pid: 93, ppid: 1, name: "node" });
    expect(
      __test.hostApp(child, tree([child, shell, claudeParent, node])),
    ).toBe("claude");
  });
});

// isAgentCmd flags a resolved sub-process command as a cross-provider agent
// CLI (copilot, gemini, codex, …) — only the leaf of a "shell › cmd" chain
// counts, since that's the command doing the work.
describe("agent CLI detection", () => {
  test("matches known agent CLIs, bare or at the end of a chain", () => {
    for (const cmd of ["copilot", "kiro", "gemini", "codex", "opencode"])
      expect(__test.isAgentCmd(cmd)).toBe(true);
    expect(__test.isAgentCmd("bash › copilot")).toBe(true);
    expect(__test.isAgentCmd("bash › npx › gemini")).toBe(true);
    expect(__test.isAgentCmd("Copilot")).toBe(true); // case-insensitive
  });

  test("does not match non-agents or agents that are not the leaf", () => {
    expect(__test.isAgentCmd("node server.js")).toBe(false);
    expect(__test.isAgentCmd("bash › make › go")).toBe(false);
    // the leaf must be the agent itself, not a tool an agent-named wrapper ran
    expect(__test.isAgentCmd("copilot-language-server")).toBe(false);
  });
});

// subprocsOf walks a session's children into the sub-process rows shown beneath
// it: descending through wrapping shells and build/task runners to the real
// tool command, dropping idle shells, and excluding nested Claude sessions
// (which get their own top-level row, so their versioned exec name must never
// appear as a child).
describe("sub-process resolution", () => {
  const proc = (over: Partial<Proc>): Proc => ({
    pid: 0,
    ppid: 0,
    rss: 0,
    cpuSec: 0,
    startSec: 0,
    path: null,
    name: "node",
    uid: 0,
    ...over,
  });
  // build the parent->children index the same way collectRows does
  const childrenOf = (procs: Proc[]) => __test.indexChildren(procs);
  // the set of top-level row PIDs collectRows excludes from every tree:
  // heuristic-detected Claude procs plus any extra registry-only sessions
  const candidatesOf = (procs: Proc[], sessionPids: number[] = []) =>
    new Set<number>([
      ...procs.filter(__test.isClaudeProc).map((p) => p.pid),
      ...sessionPids,
    ]);

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
    const cands = candidatesOf([session, nested, tool]);

    // the nested Claude is dropped from its parent's tree, and its own tool
    // child stays with it (it does NOT re-parent onto the session)
    expect(__test.subprocsOf(100, idx, cands)).toEqual([]);
    // the nested Claude lists its own sub-processes on its own row
    expect(__test.subprocsOf(101, idx, cands).map((p) => p.name)).toEqual([
      "go",
    ]);
  });

  test("excludes a nested session known only via the registry", () => {
    const session = proc({ pid: 400, name: "claude" });
    // a sub-session whose exec name/path is NOT recognized by isClaudeProc;
    // it is a top-level row only because it is in the session registry
    const nested = proc({ pid: 401, ppid: 400, name: "node", path: null });
    const tool = proc({ pid: 402, ppid: 401, name: "go" });
    const idx = childrenOf([session, nested, tool]);
    // registry-only sessions are candidates too, so they must be excluded
    // from the parent's tree just like heuristic-detected ones
    const cands = candidatesOf([session, nested, tool], [401]);

    expect(__test.subprocsOf(400, idx, cands)).toEqual([]);
    expect(__test.subprocsOf(401, idx, cands).map((p) => p.name)).toEqual([
      "go",
    ]);
  });

  test("descends a wrapping shell to the real command with a single prefix", () => {
    const session = proc({ pid: 200, name: "claude" });
    const shell = proc({ pid: 201, ppid: 200, name: "bash" });
    const cmd = proc({ pid: 202, ppid: 201, name: "go" });
    const idx = childrenOf([session, shell, cmd]);
    const cands = candidatesOf([session, shell, cmd]);
    expect(__test.subprocsOf(200, idx, cands).map((p) => p.name)).toEqual([
      "bash › go",
    ]);
  });

  test("drops an idle childless shell but keeps a real direct command", () => {
    const session = proc({ pid: 300, name: "claude" });
    const idleShell = proc({ pid: 301, ppid: 300, name: "zsh" });
    const direct = proc({ pid: 302, ppid: 300, name: "mcp-server" });
    const idx = childrenOf([session, idleShell, direct]);
    const cands = candidatesOf([session, idleShell, direct]);
    expect(__test.subprocsOf(300, idx, cands).map((p) => p.name)).toEqual([
      "mcp-server",
    ]);
  });

  test("descends a build/task runner, keeping it in the chain (make › go)", () => {
    const session = proc({ pid: 600, name: "claude" });
    const shell = proc({ pid: 601, ppid: 600, name: "bash" });
    const make = proc({ pid: 602, ppid: 601, name: "make" });
    const cmd = proc({ pid: 603, ppid: 602, name: "go" });
    const idx = childrenOf([session, shell, make, cmd]);
    const cands = candidatesOf([session, shell, make, cmd]);
    // the shell collapses to a single prefix, the runner stays in the chain
    expect(__test.subprocsOf(600, idx, cands).map((p) => p.name)).toEqual([
      "bash › make › go",
    ]);
  });

  test("keeps a childless runner (it is doing the work itself)", () => {
    const session = proc({ pid: 610, name: "claude" });
    const shell = proc({ pid: 611, ppid: 610, name: "bash" });
    const make = proc({ pid: 612, ppid: 611, name: "make" }); // compiling, no child yet
    const idx = childrenOf([session, shell, make]);
    const cands = candidatesOf([session, shell, make]);
    expect(__test.subprocsOf(610, idx, cands).map((p) => p.name)).toEqual([
      "bash › make",
    ]);
  });

  test("collapses a recursive runner into one segment (make › cc)", () => {
    const session = proc({ pid: 620, name: "claude" });
    const make = proc({ pid: 621, ppid: 620, name: "make" });
    const submake = proc({ pid: 622, ppid: 621, name: "make" }); // recursive sub-make
    const cmd = proc({ pid: 623, ppid: 622, name: "cc" });
    const idx = childrenOf([session, make, submake, cmd]);
    const cands = candidatesOf([session, make, submake, cmd]);
    expect(__test.subprocsOf(620, idx, cands).map((p) => p.name)).toEqual([
      "make › cc",
    ]);
  });

  // port attribution rolls a displayed sub-process's whole subtree up onto its
  // row, so a `npm run dev` wrapper surfaces the port its child node/vite owns.
  test("descendants gathers a sub-process subtree but stops at nested sessions", () => {
    const session = proc({ pid: 500, name: "claude" });
    const npm = proc({ pid: 501, ppid: 500, name: "npm" });
    const node = proc({ pid: 502, ppid: 501, name: "node" }); // the listener
    const nested = proc({ pid: 503, ppid: 501, name: "claude" }); // sub-session
    const tool = proc({ pid: 504, ppid: 503, name: "go" });
    const idx = childrenOf([session, npm, node, nested, tool]);
    const cands = candidatesOf([session, npm, node, nested, tool]);
    // npm's subtree includes the node that actually listens, but neither the
    // nested session nor anything under it (those own their own rows / ports)
    expect(__test.descendants(501, idx, cands).sort((a, b) => a - b)).toEqual([
      501, 502,
    ]);
  });
});

// projectForCwd attributes an orphan listener to the session whose project dir
// contains its cwd, used by the stateless orphan-port detection.
describe("projectForCwd", () => {
  const dirs = ["/Users/a/src/cctop", "/Users/a/src/flux"];

  test("matches an exact project dir", () => {
    expect(__test.projectForCwd("/Users/a/src/cctop", dirs)).toBe(
      "/Users/a/src/cctop",
    );
  });

  test("matches a subdirectory of a project", () => {
    expect(__test.projectForCwd("/Users/a/src/cctop/src/proc", dirs)).toBe(
      "/Users/a/src/cctop",
    );
  });

  test("does not match across a partial path-segment boundary", () => {
    // /Users/a/src/cctop must not swallow a sibling like .../cctop-old
    expect(__test.projectForCwd("/Users/a/src/cctop-old", dirs)).toBeNull();
  });

  test("returns null when no project contains the cwd", () => {
    expect(__test.projectForCwd("/tmp/somewhere", dirs)).toBeNull();
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

describe("usage snapshot parsing", () => {
  const snap = (rate_limits: unknown, captured_at?: unknown) => ({
    rate_limits,
    ...(captured_at !== undefined ? { captured_at } : {}),
  });

  test("parses both windows from the tap's shape", () => {
    expect(
      __test.parseUsage(
        snap(
          {
            seven_day: { used_percentage: 8, resets_at: 1781568000 },
            five_hour: { used_percentage: 60, resets_at: 1781544600 },
          },
          1781527457,
        ),
      ),
    ).toEqual({
      sevenDayPct: 8,
      sevenDayResetsAt: 1781568000,
      fiveHourPct: 60,
      fiveHourResetsAt: 1781544600,
      capturedAt: 1781527457,
    });
  });

  test("a single window is enough; the missing one is null", () => {
    expect(
      __test.parseUsage(snap({ seven_day: { used_percentage: 8 } })),
    ).toEqual({
      sevenDayPct: 8,
      sevenDayResetsAt: null,
      fiveHourPct: null,
      fiveHourResetsAt: null,
      capturedAt: null,
    });
  });

  test("treats missing / empty / non-object rate_limits as no data", () => {
    expect(__test.parseUsage({})).toBeNull();
    expect(__test.parseUsage(snap({}))).toBeNull();
    expect(__test.parseUsage(snap(null))).toBeNull();
    expect(__test.parseUsage(snap("nope"))).toBeNull();
    expect(__test.parseUsage(null)).toBeNull();
  });

  test("a window with no usable percentage counts as no data", () => {
    expect(
      __test.parseUsage(snap({ seven_day: { resets_at: 1781568000 } })),
    ).toBeNull();
  });

  test("non-numeric fields are dropped to null", () => {
    expect(
      __test.parseUsage(
        snap(
          { seven_day: { used_percentage: 8, resets_at: "soon" } },
          "yesterday",
        ),
      ),
    ).toEqual({
      sevenDayPct: 8,
      sevenDayResetsAt: null,
      fiveHourPct: null,
      fiveHourResetsAt: null,
      capturedAt: null,
    });
  });
});

describe("usage capture (captureUsage)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cctop-usage-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const payload = (rl: unknown) => JSON.stringify({ rate_limits: rl });
  const limits = {
    five_hour: { used_percentage: 60, resets_at: 1781544600 },
    seven_day: { used_percentage: 8, resets_at: 1781568000 },
  };

  test("writes a snapshot that round-trips through parseUsage", async () => {
    const f = join(dir, "ok.json");
    expect(await captureUsage(payload(limits), f)).toBe(true);
    const raw = await Bun.file(f).json();
    expect(raw.rate_limits).toEqual(limits);
    expect(typeof raw.captured_at).toBe("number");
    expect(__test.parseUsage(raw)).toEqual({
      sevenDayPct: 8,
      sevenDayResetsAt: 1781568000,
      fiveHourPct: 60,
      fiveHourResetsAt: 1781544600,
      capturedAt: raw.captured_at,
    });
  });

  test("throttles repeat writes within the 30s window", async () => {
    const f = join(dir, "throttle.json");
    expect(await captureUsage(payload(limits), f)).toBe(true);
    expect(await captureUsage(payload(limits), f)).toBe(false); // too soon
    // backdate past the window → writes again
    const old = new Date(Date.now() - 60_000);
    utimesSync(f, old, old);
    expect(await captureUsage(payload(limits), f)).toBe(true);
  });

  test("ignores missing / empty / non-object rate_limits", async () => {
    expect(await captureUsage(JSON.stringify({}), join(dir, "a.json"))).toBe(
      false,
    );
    expect(await captureUsage(payload({}), join(dir, "b.json"))).toBe(false);
    expect(await captureUsage(payload(null), join(dir, "c.json"))).toBe(false);
    expect(await captureUsage(payload([1, 2]), join(dir, "d.json"))).toBe(
      false,
    );
  });

  test("never throws on invalid input", async () => {
    expect(await captureUsage("not json", join(dir, "e.json"))).toBe(false);
    expect(await captureUsage("", join(dir, "f.json"))).toBe(false);
  });
});
