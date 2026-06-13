// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Row } from "../src/collect.ts";
import { stripAnsi } from "../src/format.ts";
import { buildFrame, renderDetail, rowKey } from "../src/render.ts";

const baseRow = (overrides: Partial<Row> = {}): Row => ({
  pid: 12345,
  mem: 512 * 1024 * 1024,
  cpu: 12.3,
  uptimeSec: 90,
  startSec: 1_700_000_000,
  state: "busy",
  kind: "interactive",
  sessionId: "session-1",
  sessionName: "session name",
  version: "2.1.177",
  host: "Ghostty",
  project: "/Users/alice/src/cctop",
  branch: "main",
  model: "claude-opus-4-8",
  contextTokens: 123_456,
  lastActivity: "2026-06-13T12:00:00.000Z",
  lastMs: Date.now(),
  prompt: "implement tests",
  transcript: "/Users/alice/.claude/projects/cctop/session-1.jsonl",
  subagents: [],
  children: [],
  ...overrides,
});

describe("render helpers", () => {
  test("uses stable row keys", () => {
    expect(rowKey(baseRow())).toBe("session-1");
    expect(rowKey(baseRow({ sessionId: null }))).toBe("pid:12345");
  });

  test("builds summary, header, and grouped rows", () => {
    const frame = buildFrame(
      [
        baseRow({
          children: [
            {
              pid: 12346,
              name: "bun test",
              mem: 128 * 1024 * 1024,
              cpu: 1.5,
              uptimeSec: 10,
            },
          ],
          subagents: [
            { model: "claude-sonnet-4", ctx: 42_000, activity: "Read" },
          ],
        }),
      ],
      160,
    );

    const text = stripAnsi(
      [...frame.summary, frame.header, ...frame.groups[0].lines].join("\n"),
    );
    expect(text).toContain("1 busy");
    expect(text).toContain("1 subagents");
    expect(text).toContain("PID");
    expect(text).toContain("cctop");
    expect(text).toContain("implement tests");
    expect(text).toContain("bun test");
  });

  test("sanitizes untrusted table text while keeping trusted styling", () => {
    const frame = buildFrame(
      [
        baseRow({
          host: "Host\x1b]52;c;secret\x07",
          project: "/tmp/proj\x1b[2Ject",
          branch: "main\x1b[31m",
          prompt: "bad\x1b]52;c;secret\x07prompt\x1b[2J",
          children: [
            {
              pid: 12346,
              name: "node\x1b[31m-red",
              mem: 0,
              cpu: 0,
              uptimeSec: 1,
            },
          ],
          subagents: [
            {
              model: "claude-sonnet-4\x1b[2J",
              ctx: 12_000,
              activity: "Read\x1b]52;c;secret\x07file",
            },
          ],
        }),
      ],
      160,
    );

    const raw = [...frame.summary, frame.header, ...frame.groups[0].lines].join(
      "\n",
    );
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x07");

    const plain = stripAnsi(raw);
    expect(plain).toContain("Host");
    expect(plain).toContain("badprompt");
    expect(plain).toContain("node-red");
    expect(plain).toContain("Readfile");
  });

  test("renders detail view with sanitized untrusted text", () => {
    const lines = renderDetail(
      baseRow({
        sessionName: "name\x1b[2J",
        prompt: "prompt\x1b]52;c;secret\x07 text",
        transcript: "/tmp/log\x1b[31m.jsonl",
      }),
      80,
    );
    const raw = lines.join("\n");
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("\x1b[2J");
    expect(stripAnsi(raw)).toContain("prompt text");
    expect(stripAnsi(raw)).toContain("/tmp/log.jsonl");
  });
});
