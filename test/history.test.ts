// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { __test as H } from "../src/collect/history.ts";
import { visLen } from "../src/format.ts";
import { __test as R, renderHistory } from "../src/history.ts";

// Local-time ISO without a trailing Z, so Date.parse treats it as local and the
// day buckets are deterministic regardless of the runner's TZ.
const aTurn = (
  ts: string,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    cwd: "/Users/a/proj",
    message: { model: "claude-sonnet-4-6", usage, content: [] },
    ...extra,
  });

describe("history aggregation", () => {
  test("buckets assistant turns by local day and sums token classes", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 5,
      }),
      aTurn("2026-06-20T05:00:00", { input_tokens: 1, output_tokens: 2 }),
      aTurn("2026-06-21T05:00:00", { input_tokens: 7 }),
    ]);
    expect(c.days.size).toBe(2);
    const d20 = c.days.get("2026-06-20")!;
    expect(d20.inputFresh).toBe(101);
    expect(d20.cacheRead).toBe(50);
    expect(d20.cacheCreate).toBe(10);
    expect(d20.output).toBe(7);
    expect(d20.turns).toBe(2);
    expect(c.days.get("2026-06-21")!.turns).toBe(1);
  });

  test("tallies model/project totals over total tokens of each turn", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 100, output_tokens: 5 }),
      aTurn("2026-06-20T02:00:00", { input_tokens: 10 }),
    ]);
    expect(c.byModel.get("claude-sonnet-4-6")).toEqual({
      tokens: 115,
      turns: 2,
    });
    // projects are keyed by full cwd now; the renderer shortens to last dirs
    expect(c.byProject.get("/Users/a/proj")).toEqual({ tokens: 115, turns: 2 });
  });

  test("counts tool_use blocks and server web tools", () => {
    const c = H.aggregateLines([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        cwd: "/p",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1,
            server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
          },
          content: [
            { type: "tool_use", name: "Bash", input: {} },
            { type: "tool_use", name: "Bash", input: {} },
            { type: "text", text: "hi" },
          ],
        },
      }),
    ]);
    expect(c.byTool.get("Bash")).toBe(2);
    expect(c.byTool.get("web_search")).toBe(2);
    expect(c.byTool.get("web_fetch")).toBe(1);
  });

  test("skips sidechain, synthetic, usage-less, and malformed lines", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 9 }, { isSidechain: true }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        message: { model: "<synthetic>", usage: { input_tokens: 9 } },
      }),
      JSON.stringify({ type: "user", timestamp: "2026-06-19T01:00:00" }),
      "{ not json",
      aTurn("2026-06-20T03:00:00", { input_tokens: 4 }),
    ]);
    expect(c.days.size).toBe(1);
    expect(c.days.get("2026-06-20")!.turns).toBe(1);
    // a user turn with no usage still sets the earliest-seen timestamp
    expect(H.dateKey(new Date(c.firstTs!))).toBe("2026-06-19");
  });

  test("a sub-agent file counts its sidechain turns and starts no session", () => {
    const c = H.aggregateLines(
      [
        aTurn(
          "2026-06-20T01:00:00",
          { input_tokens: 5 },
          { isSidechain: true },
        ),
      ],
      false, // sub-agent transcript
    );
    expect(c.days.get("2026-06-20")!.turns).toBe(1); // sidechain turn counted
    expect(c.firstTs).toBeNull(); // not a session, no session-start day
  });
});

describe("history merge", () => {
  test("gap-fills days, folds in session starts, and totals", () => {
    const c1 = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 10 }),
    ]);
    const c2 = H.aggregateLines([
      aTurn("2026-06-22T01:00:00", { input_tokens: 20 }),
    ]);
    const h = H.merge([c1, c2], 0); // 0 sub-agent files
    expect(h.days.map((d) => d.date)).toEqual([
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
    ]);
    expect(h.days[1].turns).toBe(0); // zero-filled gap day
    expect(h.days[0].sessionsStarted).toBe(1);
    expect(h.days[2].sessionsStarted).toBe(1);
    expect(h.totals).toMatchObject({
      tokens: 30,
      turns: 2,
      sessions: 2,
      subAgents: 0,
      firstDay: "2026-06-20",
      lastDay: "2026-06-22",
    });
  });

  test("folds sub-agent turns into totals but not the session count", () => {
    const main = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 10 }),
    ]);
    const sub = H.aggregateLines(
      [
        aTurn(
          "2026-06-20T02:00:00",
          { input_tokens: 7 },
          { isSidechain: true },
        ),
      ],
      false,
    );
    const h = H.merge([main, sub], 1); // 1 sub-agent file
    expect(h.totals.sessions).toBe(1); // only the session file
    expect(h.totals.subAgents).toBe(1);
    expect(h.totals.turns).toBe(2); // both turns counted
    expect(h.totals.tokens).toBe(17);
    expect(h.days[0].turns).toBe(2);
  });
});

describe("activity chart", () => {
  test("an active day never scales down to a blank bar", () => {
    expect(R.barEighths(0, 1000)).toBe(0); // no activity → blank
    expect(R.barEighths(1, 1000)).toBe(1); // tiny day still shows one eighth
    expect(R.barEighths(26, 3690)).toBeGreaterThanOrEqual(1); // the regression
    expect(R.barEighths(1000, 1000)).toBe(56); // peak fills the full height
  });
});

describe("formatting", () => {
  test("big formats compact magnitudes", () => {
    expect(R.big(500)).toBe("500");
    expect(R.big(1500)).toBe("2k");
    expect(R.big(1_500_000)).toBe("1.5M");
    expect(R.big(2_000_000_000)).toBe("2.0B");
  });
});

describe("renderHistory", () => {
  test("empty history shows a note, not charts", () => {
    const h = H.merge([], 0);
    const lines = renderHistory(h, 80);
    expect(lines.join("\n")).toContain("No transcript history");
  });

  test("every rendered row fits the column budget", () => {
    const c = H.aggregateLines([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        cwd: "/Users/a/some-long-project-name",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 200,
            output_tokens: 300,
          },
          content: [{ type: "tool_use", name: "Bash", input: {} }],
        },
      }),
      aTurn("2026-06-25T02:00:00", { input_tokens: 42, output_tokens: 9 }),
    ]);
    const h = H.merge([c], 1);
    for (const width of [60, 80, 120]) {
      for (const line of renderHistory(h, width))
        expect(visLen(line)).toBeLessThanOrEqual(width);
    }
  });
});
