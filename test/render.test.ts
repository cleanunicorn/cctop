// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Instance, Usage } from "../src/collect.ts";
import { BLUE, BOLD, RED, RESET, stripAnsi, YELLOW } from "../src/format.ts";
import { buildFrame, renderDetail, rowKey, usageLine } from "../src/render.ts";

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
              ports: [5173],
            },
          ],
          subagents: [
            {
              model: "claude-sonnet-4",
              ctx: 42_000,
              activity: "Read",
              uptimeSec: 65,
            },
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
    // connected tree gutter: ● session, then a spine of branches — the
    // sub-agent runs a long arm out to its (markerless) UP column, the lone
    // sub-process closes the spine with └─
    expect(text).toContain("●");
    expect(text).toMatch(/├─{4,}/);
    expect(text).toContain("└─");
  });

  test("caps sub-agent and sub-process rows in list view; detail shows all", () => {
    const subagents = Array.from({ length: 12 }, (_, i) => ({
      model: "claude-haiku-4-5-20251001",
      ctx: 18_000 - i * 500,
      activity: `Bash: job ${i + 1}`,
      uptimeSec: 300 - i * 10,
    }));
    const children = Array.from({ length: 11 }, (_, i) => ({
      pid: 90_000 + i,
      name: `bash › sleep ${i + 1}`,
      mem: 1024 * 1024,
      cpu: 0.1,
      uptimeSec: 120,
      ports: [],
    }));
    const row = baseRow({ subagents, children });

    const lines = buildFrame([row], 120).groups[0].lines;
    const text = stripAnsi(lines.join("\n"));
    // 1 session + 8 agents + 1 overflow + 8 procs + 1 overflow
    expect(lines.length).toBe(19);
    expect(text).toContain("+4 sub-agents");
    expect(text).toContain("+3 processes");
    // the overflow line is the closer (└), so every shown child branches with
    // ├ — no child stat row (└ followed by its pid) gets the closing glyph
    expect(text).not.toMatch(/└\s+\d/);
    expect(text).toContain("├");

    const detail = stripAnsi(renderDetail(row, 120).join("\n"));
    expect(detail).toContain("Sub-agents (12)");
    expect(detail).toContain("Sub-processes (11)");
    expect(detail).toContain("Bash: job 12");
    expect(detail).toContain("bash › sleep 11");
    expect(detail).toContain("Last Turn");
    // the tool name is tagged and the colon dropped: "Edit: render.ts" → "Edit render.ts"
    expect(detail).toContain("Edit render.ts");
    expect(detail).toContain("│"); // quoted blocks get a left gutter
  });

  test("detail view lists a sub-process's listening ports", () => {
    const row = baseRow({
      children: [
        {
          pid: 12346,
          name: "node server.js",
          mem: 64 * 1024 * 1024,
          cpu: 2.0,
          uptimeSec: 30,
          ports: [3000, 8080],
        },
        {
          pid: 12347,
          name: "bash › make build",
          mem: 1024 * 1024,
          cpu: 0,
          uptimeSec: 5,
          ports: [],
        },
      ],
    });
    const detail = stripAnsi(renderDetail(row, 120).join("\n"));
    // a listening process shows each port; one with none shows no stray colon
    expect(detail).toContain("node server.js  :3000 :8080");
    expect(detail).toContain("bash › make build");
    expect(detail).not.toContain("make build  :");
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
              ports: [],
            },
          ],
          subagents: [
            {
              model: "claude-sonnet-4\x1b[2J",
              ctx: 12_000,
              activity: "Read\x1b]52;c;secret\x07file",
              uptimeSec: 30,
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
        lastTurn: "Bash\x1b]52;c;secret\x07: ls\x1b[2J",
        transcript: "/tmp/log\x1b[31m.jsonl",
      }),
      80,
    );
    const raw = lines.join("\n");
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("\x1b[2J");
    expect(stripAnsi(raw)).toContain("prompt text");
    expect(stripAnsi(raw)).toContain("Bash ls");
    expect(stripAnsi(raw)).toContain("/tmp/log.jsonl");
  });

  test("renders inline markdown (bold + code) in a text turn", () => {
    const raw = renderDetail(
      baseRow({ lastTurn: "squashed into **ahead 1** at `e0d7429` now" }),
      80,
    ).join("\n");
    // bold wraps the bolded word; inline code is blue
    expect(raw).toContain(`${BOLD}ahead${RESET}`);
    expect(raw).toContain(`${BLUE}e0d7429${RESET}`);
    // markers are stripped from the visible text
    const plain = stripAnsi(raw);
    expect(plain).toContain("ahead 1");
    expect(plain).toContain("e0d7429");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("`");
  });

  test("marks a brand-new session (no prompt/turn/context) in list and detail", () => {
    const fresh = baseRow({
      prompt: null,
      lastTurn: null,
      promptAt: null,
      contextTokens: null,
      sessionName: "Fresh Start",
    });
    // list: the PROMPT column reads "new session", not the session name
    const frame = buildFrame([fresh], 160);
    const rowLine = stripAnsi(frame.groups[0].lines[0]);
    expect(rowLine).toContain("new session");
    expect(rowLine).not.toContain("Fresh Start");
    // detail: one note, no Last Turn block
    const detail = stripAnsi(renderDetail(fresh, 120).join("\n"));
    expect(detail).toContain("new session — nothing yet");
    expect(detail).not.toContain("Last Turn");

    // a session with any activity is not "new"
    const active = stripAnsi(
      renderDetail(baseRow({ contextTokens: 5000 }), 120).join("\n"),
    );
    expect(active).not.toContain("new session");
    expect(active).toContain("Last Turn");
  });

  test("shows last prompt/turn times in the headers, not the state row", () => {
    const detail = stripAnsi(renderDetail(baseRow(), 120).join("\n"));
    expect(detail).toMatch(/Last Prompt\s+\d+\w ago/);
    expect(detail).toMatch(/Last Turn\s+\d+\w ago/);
    expect(detail).not.toContain("last turn"); // moved out of the state row
  });

  test("trims a long prompt at the head and a long text turn at the tail", () => {
    const many = (p: string) =>
      Array.from({ length: 60 }, (_, i) => `${p}${i}`).join(" ");
    const lines = renderDetail(
      baseRow({ prompt: many("P"), lastTurn: many("T") }),
      50,
    ).map(stripAnsi);
    const blockAfter = (header: string) => {
      const out: string[] = [];
      for (
        let i = lines.findIndex((l) => l.startsWith(header)) + 1;
        lines[i]?.startsWith("│");
        i++
      )
        out.push(lines[i]);
      return out;
    };
    const prompt = blockAfter("Last Prompt");
    const turn = blockAfter("Last Turn");
    expect(prompt).toHaveLength(3); // capped to BLOCK_LINES
    expect(turn).toHaveLength(3);
    // prompt keeps the head, … trails on the last line
    expect(prompt.join(" ")).toContain("P0");
    expect(prompt.join(" ")).not.toContain("P59");
    expect(prompt[2]).toContain("…");
    // turn keeps the tail, … leads on the first line
    expect(turn.join(" ")).toContain("T59");
    expect(turn.join(" ")).not.toContain("T0");
    expect(turn[0]).toContain("…");
  });
});

describe("usage limits line", () => {
  const NOW = 1_700_000_000_000; // fixed clock so countdowns are deterministic
  const sec = NOW / 1000;
  const usage = (o: Partial<Usage> = {}): Usage => ({
    sevenDayPct: null,
    sevenDayResetsAt: null,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    capturedAt: sec,
    ...o,
  });

  test("formats both windows with two-unit reset countdowns", () => {
    const line = usageLine(
      usage({
        sevenDayPct: 8,
        sevenDayResetsAt: sec + 2 * 86400 + 9 * 3600,
        fiveHourPct: 60,
        fiveHourResetsAt: sec + 2 * 3600 + 32 * 60,
      }),
      NOW,
    );
    expect(stripAnsi(line ?? "")).toBe(
      "Limits: 8% 7d (2d9h left)  60% 5h (2h32m left)",
    );
  });

  test("rounds percentages and shows a single window alone", () => {
    expect(stripAnsi(usageLine(usage({ sevenDayPct: 8.7 }), NOW) ?? "")).toBe(
      "Limits: 9% 7d",
    );
  });

  test("heats high percentages toward red, leaves low ones plain", () => {
    const hot = usageLine(usage({ sevenDayPct: 92, fiveHourPct: 60 }), NOW)!;
    expect(hot).toContain(`${RED}92%`); // 92% -> red
    expect(hot).toContain(`${YELLOW}60%`); // 60% -> yellow
    const cool = usageLine(usage({ sevenDayPct: 8 }), NOW)!;
    expect(cool).not.toContain(RED);
    expect(cool).not.toContain(YELLOW);
  });

  test("appends the snapshot age when stale, keeping heat colors", () => {
    const line = usageLine(
      usage({
        sevenDayPct: 92,
        sevenDayResetsAt: sec + 2 * 86400,
        capturedAt: sec - 2 * 3600, // 2h old, past the 1h staleness window
      }),
      NOW,
    );
    expect(stripAnsi(line ?? "")).toBe("Limits: 92% 7d (2d left)  · 2h ago");
    expect(line).toContain(RED); // colors kept — the line is not dimmed
  });

  test("does not flag a recent snapshot as stale", () => {
    const line = usageLine(
      usage({ sevenDayPct: 8, capturedAt: sec - 30 * 60 }), // 30m, within 1h
      NOW,
    );
    expect(stripAnsi(line ?? "")).toBe("Limits: 8% 7d");
  });

  test("shows (due) for a window whose reset moment has already passed", () => {
    expect(
      stripAnsi(
        usageLine(
          usage({ fiveHourPct: 60, fiveHourResetsAt: sec - 10 }),
          NOW,
        ) ?? "",
      ),
    ).toBe("Limits: 60% 5h (due)");
  });

  test("returns null when there is no usable data", () => {
    expect(usageLine(null, NOW)).toBeNull();
    expect(usageLine(usage(), NOW)).toBeNull();
  });
});
