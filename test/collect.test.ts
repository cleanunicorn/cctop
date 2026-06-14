// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test, matchRow, type Row } from "../src/collect.ts";

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
