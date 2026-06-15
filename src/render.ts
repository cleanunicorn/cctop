// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// ANSI rendering: the top-style summary, the session table with its
// sub-process / sub-agent tree, and the per-session detail view. Pure
// functions over already-collected rows; the interactive runtime (app.ts)
// layers selection, scrolling, and overlays on top.

import type { Row, Usage } from "./collect.ts";
import {
  BOLD,
  BRIGHT_GREEN,
  CYAN,
  cpuColor,
  ctxColor,
  DIM,
  formatCountdown,
  formatDuration,
  formatMem,
  formatTokens,
  heatNum,
  pad,
  RED,
  RESET,
  sanitizeDisplay,
  shortProject,
  stateDot,
  stateWord,
  tildePath,
  truncate,
  visLen,
} from "./format.ts";

// A stable identity for a session row that survives re-sorting across
// refreshes, so the selection cursor stays put.
export const rowKey = (r: Row) => r.sessionId ?? `pid:${r.pid}`;

// `min` reserves a stable width for the volatile numeric columns so a
// changing value (cpu spiking to "100.0%", mem growing) does not resize the
// column and shove every column to its right around between refreshes
interface Col {
  key: string;
  header: string;
  align: "l" | "r";
  min?: number;
}
const cols: Col[] = [
  // first column is the tree gutter: a colored status dot (●) on session rows,
  // then a connected spine of branches for its children. Sub-processes branch
  // with ├─/└─ into their stats; sub-agents have no stats columns, so their
  // branch runs an arm out to the UP column, where their cyan stats begin.
  // Headerless — the glyphs speak for themselves, like systemd's status dot.
  { key: "state", header: "", align: "l" },
  { key: "pid", header: "PID", align: "r", min: 5 },
  { key: "mem", header: "MEM", align: "r", min: 4 },
  { key: "cpu", header: "CPU", align: "r", min: 5 }, // up to "99.9%"
  { key: "up", header: "UP", align: "r", min: 3 },
  { key: "ctx", header: "CTX", align: "r", min: 4 }, // up to "999k"
  { key: "model", header: "MODEL", align: "l" },
  { key: "ver", header: "VER", align: "l" },
  { key: "host", header: "HOST", align: "l" },
  { key: "project", header: "PROJECT", align: "l" },
  { key: "branch", header: "BRANCH", align: "l" },
  { key: "last", header: "LAST", align: "r", min: 3 },
  { key: "prompt", header: "PROMPT", align: "l" },
];

// pid/mem/cpu/up are shared between a session and its sub-process rows,
// so these columns align across both and their widths consider children
const TREE_COLS = ["pid", "mem", "cpu", "up"];

// In list view a single session must not crowd the others off-screen, so cap
// how many sub-agent and sub-process rows it shows; the overflow is summarized
// on one line and the detail view (Enter) still lists every one.
const MAX_SUBAGENT_ROWS = 8;
const MAX_CHILD_ROWS = 8;

type Cells = Record<string, string>;
const safe = (s: string | null | undefined, fallback = "-") =>
  sanitizeDisplay(s ?? fallback);

// Model ids shown compactly: drop the "claude-" prefix and any trailing
// -YYYYMMDD date stamp, so "claude-haiku-4-5-20251001" reads "haiku-4-5" and
// lines up with undated ids like "opus-4-8" across sessions and sub-agents.
const shortModel = (m: string | null | undefined) =>
  m?.replace(/^claude-/, "").replace(/-\d{8}$/, "");

// Paint a session cell: status dot, heat-colored cpu/ctx, dimmed units,
// dimmed placeholders; everything else as-is.
function styleCell(key: string, value: string, raw: Row) {
  if (value === "-") return `${DIM}-${RESET}`;
  switch (key) {
    case "state":
      return stateDot(raw.state);
    case "cpu": {
      const c = cpuColor(raw.cpu);
      return c ? heatNum(value, c) : value;
    }
    case "ctx": {
      const c = ctxColor(raw.contextTokens ?? 0);
      return c ? heatNum(value, c) : value;
    }
    default:
      return value;
  }
}

export interface Group {
  key: string;
  lines: string[];
}

// "Limits: 8% 7d (2d left)  60% 5h (40m left)" — the account-wide rate-limit
// summary line, from the status-line tap's snapshot (collect.ts readUsage()).
// Percentages heat toward red as they climb (like CPU); the "(… left)" comes
// from the absolute reset time, so it stays accurate even when the snapshot is
// stale. Returns null when there is no usable data, so the summary just omits
// the line. Once the snapshot is over an hour old, its age is appended so a
// stale reading isn't mistaken for a live one (the percentages stop updating
// when no session is active to refresh them).
const USAGE_STALE_MS = 60 * 60_000;
export function usageLine(
  usage: Usage | null,
  nowMs = Date.now(),
): string | null {
  if (!usage) return null;
  const segs: string[] = [];
  const win = (pct: number | null, label: string, resetsAt: number | null) => {
    if (pct == null) return;
    const p = Math.round(pct);
    const c = cpuColor(p);
    const head = `${c ? heatNum(`${p}%`, c) : `${p}%`} ${label}`;
    // "(due)" once the reset moment has passed: the window should have reset but
    // the snapshot still carries the old percentage (it lags behind real time)
    const hint =
      resetsAt == null
        ? ""
        : resetsAt * 1000 > nowMs
          ? `(${formatCountdown(resetsAt - nowMs / 1000)} left)`
          : "(due)";
    segs.push(hint ? `${head} ${DIM}${hint}${RESET}` : head);
  };
  win(usage.sevenDayPct, "7d", usage.sevenDayResetsAt);
  win(usage.fiveHourPct, "5h", usage.fiveHourResetsAt);
  if (!segs.length) return null;
  let line = `${DIM}Limits:${RESET} ${segs.join("  ")}`;
  if (
    usage.capturedAt != null &&
    nowMs - usage.capturedAt * 1000 > USAGE_STALE_MS
  ) {
    const age = formatDuration(nowMs / 1000 - usage.capturedAt);
    line += `  ${DIM}· ${age} ago${RESET}`;
  }
  return line;
}

export interface Frame {
  message?: string;
  summary: string[];
  header: string;
  groups: Group[];
}

// Build the full table frame from already-collected rows. `termCols` is the
// width available to the table body (the caller subtracts any left gutter).
export function buildFrame(
  rows: Row[],
  termCols: number,
  usage?: Usage | null,
): Frame {
  const nowMs = Date.now();
  const view = rows.map((r) => ({
    raw: r,
    cells: {
      pid: String(r.pid),
      mem: formatMem(r.mem),
      cpu: `${r.cpu.toFixed(1)}%`,
      up: formatDuration(r.uptimeSec),
      state: r.state,
      ctx: r.contextTokens ? formatTokens(r.contextTokens) : "-",
      model: safe(shortModel(r.model)),
      ver: safe(r.version),
      host: safe(r.host),
      project: safe(shortProject(r.project)),
      branch: safe(r.branch),
      last: r.lastMs ? formatDuration((nowMs - r.lastMs) / 1000) : "-",
      prompt: safe(r.prompt ?? r.sessionName),
    } as Cells,
    children: r.children.map((c) => ({
      pid: String(c.pid),
      mem: formatMem(c.mem),
      cpu: `${c.cpu.toFixed(1)}%`,
      up: formatDuration(c.uptimeSec),
      name: safe(c.name),
    })),
    subagents: r.subagents.map((a) => ({
      ...a,
      model: a.model ? safe(a.model) : null,
      activity: a.activity ? safe(a.activity) : null,
    })),
  }));

  // top-style summary: session counts by state, plus the total CPU,
  // memory, and sub-process footprint of Claude (sessions and children)
  let busy = 0;
  let idle = 0; // everything not busy with a known status (idle/waiting/shell/…)
  let totalCpu = 0;
  let totalMem = 0;
  let totalProcs = 0;
  let totalAgents = 0;
  for (const { raw } of view) {
    if (raw.state === "busy") busy++;
    else if (raw.state !== "?") idle++;
    totalCpu += raw.cpu;
    totalMem += raw.mem;
    totalProcs += 1 + raw.children.length; // the session plus its children
    totalAgents += raw.subagents.length;
    for (const c of raw.children) {
      totalCpu += c.cpu;
      totalMem += c.mem;
    }
  }
  const states: string[] = [];
  if (busy) states.push(`${BRIGHT_GREEN}●${RESET} ${busy} busy`);
  if (idle) states.push(`${RED}●${RESET} ${idle} idle`);
  const summary = [
    `${DIM}Sessions:${RESET} ${states.join("  ") || view.length}` +
      (totalAgents ? `   ${CYAN}◆${RESET} ${totalAgents} subagents` : ""),
    // value-first ("1.8% cpu") to match the Sessions line's "1 busy" style
    `${DIM}Resources:${RESET} ${totalCpu.toFixed(1)}% cpu  ${formatMem(
      totalMem,
    )} mem  ${totalProcs} procs`,
  ];
  // account-wide rate limits, when the status-line tap has captured them
  const limits = usageLine(usage ?? null, nowMs);
  if (limits) summary.push(limits);

  // widths use the plain cell text (color is added afterward); the state
  // column is the tree gutter, 2 wide — a status dot, or a branch plus a
  // per-child marker (├◆ agent, ├─ process); tree columns also fit child values
  const widths = cols.map(({ key, header, min = 0 }) => {
    if (key === "state") return 2; // ● dot, or ├◆ / ├─ branch+marker
    let w = Math.max(
      header.length,
      min,
      ...view.map((r) => r.cells[key].length),
    );
    if (TREE_COLS.includes(key))
      for (const r of view)
        for (const c of r.children) w = Math.max(w, (c as any)[key].length);
    return w;
  });
  // the trailing prompt column absorbs whatever terminal width is left
  const fixed =
    widths.slice(0, -1).reduce((a, b) => a + b, 0) + 2 * (cols.length - 1);
  const avail = Math.max(termCols - fixed, 12);
  widths[widths.length - 1] = Math.min(widths.at(-1)!, avail);

  const header = cols
    .map(
      ({ header, align }, i) =>
        `${BOLD}${pad(header, widths[i], align === "r")}${RESET}`,
    )
    .join("  ");

  const sessionLine = (cells: Cells, raw: Row) =>
    cols
      .map(({ key, align }, i) => {
        let plain = cells[key];
        if (i === cols.length - 1 && plain.length > widths[i])
          plain = truncate(plain, widths[i]);
        return pad(styleCell(key, plain, raw), widths[i], align === "r");
      })
      .join("  ");

  const stateI = cols.findIndex((c) => c.key === "state");

  // a sub-process row: a tree branch in the state gutter, then pid/mem/cpu/up
  // aligned under the session's columns, then the command name; the whole row
  // is dimmed so sessions stay the focus
  const childLine = (c: any, isLast: boolean) => {
    const branch = pad(isLast ? "└─" : "├─", widths[stateI]);
    const stats = TREE_COLS.map((key) => {
      const i = cols.findIndex((col) => col.key === key);
      return pad(c[key], widths[i], cols[i].align === "r");
    }).join("  ");
    const head = `${branch}  ${stats}  `;
    const room = Math.max(termCols - visLen(head), 8);
    const name =
      c.name.length > room ? `${c.name.slice(0, room - 1)}…` : c.name;
    return `${DIM}${head}${name}${RESET}`;
  };

  // a live sub-agent row: branches off the same spine as the processes, but it
  // has no pid/mem/cpu of its own, so the branch runs a horizontal arm across
  // those empty columns out to the UP column, where the agent's own stats begin
  // — all cyan: uptime (from the transcript's creation time), then ctx/model
  // under the parent's columns, with the action flowing free after.
  const ctxI = cols.findIndex((c) => c.key === "ctx");
  const modelI = cols.findIndex((c) => c.key === "model");
  const upI = cols.findIndex((c) => c.key === "up");
  // the arm a sub-agent row draws: spans the gutter and the empty pid/mem/cpu
  // columns (with their separators), reaching the UP column where its stats begin
  const agentArmW =
    widths[stateI] +
    ["pid", "mem", "cpu"].reduce((sum, key) => {
      const i = cols.findIndex((col) => col.key === key);
      return sum + 2 + widths[i];
    }, 0);
  const agentArm = (isLast: boolean) =>
    `${isLast ? "└" : "├"}${"─".repeat(Math.max(0, agentArmW - 1))}`;
  const agentLine = (a: any, isLast: boolean) => {
    const arm = agentArm(isLast);
    const up = pad(
      a.uptimeSec != null ? formatDuration(a.uptimeSec) : "",
      widths[upI],
      true,
    );
    const ctx = pad(
      a.ctx != null ? formatTokens(a.ctx) : "?",
      widths[ctxI],
      true,
    );
    const model = pad(shortModel(a.model) ?? "agent", widths[modelI], false);
    const prefix = `${arm}  ${up}  ${ctx}  ${model}`;
    const room = Math.max(termCols - visLen(prefix) - 2, 8);
    let activity = a.activity ?? "";
    if (activity.length > room) activity = `${activity.slice(0, room - 1)}…`;
    const tail = activity ? `  ${activity}` : "";
    return `${DIM}${arm}${RESET}  ${CYAN}${up}  ${ctx}  ${model}${tail}${RESET}`;
  };

  // a dim summary line that stands in for capped sub-agent/sub-process rows; it
  // reuses the same arm/branch as the rows it replaces so it sits flush on the
  // spine instead of dangling off a stub pipe
  const moreLine = (arm: string, hidden: number, noun: string) =>
    `${DIM}${arm}  +${hidden} ${noun}${RESET}`;

  // each group is a session row, then its live sub-agents (◆), then its
  // sub-process tree (─), all hanging off one connected spine: every child
  // branches with ├ and only the final line of the group closes it with └.
  // Kept together so truncation never orphans them; each kind is capped so one
  // busy session can't fill the view.
  const groups: Group[] = view.map((r) => {
    const lines = [sessionLine(r.cells, r.raw)];

    const agents = r.subagents.slice(0, MAX_SUBAGENT_ROWS);
    const moreAgents = r.subagents.length - agents.length;
    const kids = r.children.slice(0, MAX_CHILD_ROWS);
    const moreKids = r.children.length - kids.length;

    // total child lines, so the very last one (whatever kind) gets the └ closer
    const total =
      agents.length +
      (moreAgents > 0 ? 1 : 0) +
      kids.length +
      (moreKids > 0 ? 1 : 0);
    let n = 0;
    const last = () => ++n === total;

    for (const a of agents) lines.push(agentLine(a, last()));
    if (moreAgents > 0)
      lines.push(moreLine(agentArm(last()), moreAgents, "sub-agents"));
    for (const c of kids) lines.push(childLine(c, last()));
    if (moreKids > 0)
      lines.push(
        moreLine(
          pad(last() ? "└─" : "├─", widths[stateI]),
          moreKids,
          "processes",
        ),
      );

    return { key: rowKey(r.raw), lines };
  });

  return { summary, header, groups };
}

// --- Detail view -----------------------------------------------------------

const label = (s: string) => `${DIM}${pad(s, 9)}${RESET}`;

// A full-screen panel for one session: everything the row truncates, shown
// in full. Returns the body lines (caller adds title/footer chrome).
export function renderDetail(r: Row, termCols: number): string[] {
  const width = Math.max(termCols, 20);
  const wrap = (text: string, indent = 0): string[] => {
    const room = Math.max(width - indent, 8);
    const words = text.split(/\s+/);
    const out: string[] = [];
    let line = "";
    for (const w of words) {
      if (line && `${line} ${w}`.length > room) {
        out.push(`${" ".repeat(indent)}${line}`);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) out.push(" ".repeat(indent) + line);
    return out.length ? out : [" ".repeat(indent)];
  };

  const dot = stateDot(r.state);
  const out: string[] = [];
  const projectShort = safe(shortProject(r.project), "?");
  out.push(`${dot} ${BOLD}${projectShort}${RESET}`);
  out.push("");
  out.push(`${label("session")}${safe(r.sessionId)}`);
  out.push(`${label("uptime")}${formatDuration(r.uptimeSec)}`);
  const ago = r.lastMs ? formatDuration((Date.now() - r.lastMs) / 1000) : "-";
  out.push(
    `${label("state")}${stateWord(safe(r.state))}  ${DIM}·${RESET}  last turn ${ago} ago`,
  );
  out.push(`${label("pid")}${r.pid}  ${DIM}·${RESET}  ${safe(r.kind)}`);
  const cpuC = cpuColor(r.cpu);
  const cpuStr = `${r.cpu.toFixed(1)}%`;
  out.push(
    `${label("cpu/mem")}${cpuC ? heatNum(cpuStr, cpuC) : cpuStr}  ${DIM}·${RESET}  ${formatMem(r.mem)}`,
  );
  const ctx =
    r.contextTokens != null
      ? (() => {
          const c = ctxColor(r.contextTokens);
          const s = formatTokens(r.contextTokens);
          return c ? heatNum(s, c) : s;
        })()
      : "-";
  out.push(`${label("context")}${ctx}`);
  out.push(`${label("model")}${safe(shortModel(r.model))}`);
  out.push(`${label("host")}${safe(r.host)}`);
  // full cwd (not the table's shortened last segment), home root as ~
  out.push(
    `${label("project")}${safe(r.project ? tildePath(r.project) : null)}`,
  );
  out.push(`${label("branch")}${safe(r.branch)}`);
  if (r.transcript) {
    // relative to ~/.claude/ — the absolute prefix is just noise in this view
    const log = r.transcript.replace(/^.*\/\.claude\//, "");
    out.push(`${label("log")}${safe(log)}`);
  }

  out.push("");
  out.push(`${BOLD}Last Prompt${RESET}`);
  out.push(...wrap(safe(r.prompt ?? r.sessionName), 2));

  if (r.subagents.length) {
    out.push("");
    out.push(`${BOLD}Sub-agents${RESET} ${DIM}(${r.subagents.length})${RESET}`);
    for (const a of r.subagents) {
      const model = safe(shortModel(a.model), "agent");
      const ac = a.ctx != null ? formatTokens(a.ctx) : "?";
      const line = `${CYAN}◆${RESET} ${model} · ${ac} ctx · up ${formatDuration(
        a.uptimeSec,
      )}${a.activity ? ` · ${safe(a.activity)}` : ""}`;
      out.push(truncate(line, width + (line.length - visLen(line))));
    }
  }

  if (r.children.length) {
    out.push("");
    out.push(
      `${BOLD}Sub-processes${RESET} ${DIM}(${r.children.length})${RESET}`,
    );
    for (const c of r.children) {
      const stats = `${pad(String(c.pid), 6, true)} ${pad(
        formatMem(c.mem),
        5,
        true,
      )} ${pad(`${c.cpu.toFixed(1)}%`, 6, true)} ${pad(
        formatDuration(c.uptimeSec),
        3,
        true,
      )}`;
      const room = Math.max(width - stats.length - 3, 8);
      out.push(`${DIM}${stats}${RESET}  ${truncate(safe(c.name), room)}`);
    }
  }
  return out;
}
