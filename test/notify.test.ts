// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Instance } from "../src/collect.ts";
import { finishedSessions, notifySeq } from "../src/notify.ts";

const baseRow = (overrides: Partial<Instance> = {}): Instance => ({
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
  promptAt: Date.now() - 120_000,
  lastTurn: "Edit: render.ts",
  transcript: "/Users/alice/.claude/projects/cctop/session-1.jsonl",
  subagents: [],
  children: [],
  orphanPorts: [],
  ...overrides,
});

const MIN = 3000; // pass explicitly so the tests don't track the default

describe("finishedSessions", () => {
  test("rings when a session busy past the threshold flips to idle", () => {
    const busySince = new Map<string, number>();
    expect(finishedSessions(busySince, [baseRow()], 0, MIN)).toEqual([]);
    const idle = baseRow({ state: "idle" });
    expect(finishedSessions(busySince, [idle], MIN, MIN)).toEqual([idle]);
    // the flip is consumed: staying idle does not ring again
    expect(finishedSessions(busySince, [idle], MIN + 1000, MIN)).toEqual([]);
  });

  test("a session first seen idle never rings", () => {
    const busySince = new Map<string, number>();
    const idle = baseRow({ state: "waiting" });
    expect(finishedSessions(busySince, [idle], 0, MIN)).toEqual([]);
    expect(finishedSessions(busySince, [idle], MIN * 2, MIN)).toEqual([]);
  });

  test("a sub-threshold busy blip stays silent", () => {
    const busySince = new Map<string, number>();
    finishedSessions(busySince, [baseRow()], 0, MIN);
    expect(
      finishedSessions(busySince, [baseRow({ state: "idle" })], MIN - 1, MIN),
    ).toEqual([]);
    // and the blip is forgotten: going busy again restarts the clock
    finishedSessions(busySince, [baseRow()], MIN, MIN);
    expect(busySince.get("session-1")).toBe(MIN);
  });

  test("a flip to unknown state means lost registry data, not done", () => {
    const busySince = new Map<string, number>();
    finishedSessions(busySince, [baseRow()], 0, MIN);
    expect(
      finishedSessions(busySince, [baseRow({ state: "?" })], MIN, MIN),
    ).toEqual([]);
    expect(busySince.size).toBe(0);
  });

  test("a session that exits while busy is pruned, not rung", () => {
    const busySince = new Map<string, number>();
    finishedSessions(busySince, [baseRow()], 0, MIN);
    expect(finishedSessions(busySince, [], MIN, MIN)).toEqual([]);
    expect(busySince.size).toBe(0);
  });

  test("tracks sessions independently by row key", () => {
    const busySince = new Map<string, number>();
    const a = baseRow();
    const b = baseRow({ sessionId: "session-2", pid: 222 });
    finishedSessions(busySince, [a, b], 0, MIN);
    // a flips, b stays busy
    const aIdle = baseRow({ state: "waiting" });
    expect(finishedSessions(busySince, [aIdle, b], MIN, MIN)).toEqual([aIdle]);
    expect(busySince.has("session-2")).toBe(true);
  });
});

describe("notifySeq", () => {
  test("BEL then an OSC 9 message naming project and branch", () => {
    expect(notifySeq([baseRow({ state: "idle" })])).toBe(
      "\x07\x1b]9;cctop: cctop (main) is waiting for input\x07",
    );
  });

  test("summarizes multiple flips in one notification", () => {
    const rows = [
      baseRow({ state: "idle", branch: null }),
      baseRow({ state: "idle", sessionId: "session-2" }),
    ];
    expect(notifySeq(rows)).toBe(
      "\x07\x1b]9;cctop: cctop +1 more are waiting for input\x07",
    );
  });

  test("control bytes in names cannot break out of the OSC string", () => {
    const evil = baseRow({
      state: "idle",
      project: "/tmp/pwn\x07\x1b]0;x",
      branch: "b\x1b[31mred",
    });
    const seq = notifySeq([evil]);
    // exactly the leading BEL and the OSC terminator survive
    expect(seq.match(/\x07/g)?.length).toBe(2);
    expect(seq.endsWith("\x07")).toBe(true);
    expect(seq.slice(1, -1).includes("\x1b[31m")).toBe(false);
  });
});
