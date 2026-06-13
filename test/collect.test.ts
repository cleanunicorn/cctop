// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { __test, matchRow, type Row } from "../src/collect.ts";

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
