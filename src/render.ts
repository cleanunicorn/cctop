// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// ANSI rendering: the top-style summary, the session table with its
// sub-process / sub-agent tree, and the per-session detail view. Pure
// functions over already-collected rows; the interactive runtime (app.ts)
// layers selection, scrolling, and overlays on top.

import type { Row } from "./collect.ts";
import {
  BOLD,
  BRIGHT_GREEN,
  CYAN,
  cpuColor,
  ctxColor,
  DIM,
  formatDuration,
  formatMem,
  formatTokens,
  heatNum,
  pad,
  RED,
  RESET,
  shortProject,
  stateDot,
  truncate,
  visLen,
  YELLOW,
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
  { key: "pid", header: "PID", align: "r", min: 5 },
  { key: "mem", header: "MEM", align: "r", min: 4 },
  { key: "cpu", header: "CPU", align: "r", min: 5 }, // up to "99.9%"
  { key: "up", header: "UP", align: "r", min: 3 },
  { key: "state", header: "S", align: "l" }, // status dot (● busy / ● idle)
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

type Cells = Record<string, string>;

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

export interface Frame {
  message?: string;
  summary: string[];
  header: string;
  groups: Group[];
}

// Build the full table frame from already-collected rows. `termCols` is the
// width available to the table body (the caller subtracts any left gutter).
export function buildFrame(rows: Row[], termCols: number): Frame {
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
      model: r.model?.replace(/^claude-/, "") ?? "-",
      ver: r.version ?? "-",
      host: r.host,
      project: shortProject(r.project),
      branch: r.branch ?? "-",
      last: r.lastMs ? formatDuration((nowMs - r.lastMs) / 1000) : "-",
      prompt: r.prompt ?? r.sessionName ?? "-",
    } as Cells,
    children: r.children.map((c) => ({
      pid: String(c.pid),
      mem: formatMem(c.mem),
      cpu: `${c.cpu.toFixed(1)}%`,
      up: formatDuration(c.uptimeSec),
      name: c.name,
    })),
    subagents: r.subagents,
  }));

  // top-style summary: session counts by state, plus the total CPU,
  // memory, and sub-process footprint of Claude (sessions and children)
  let busy = 0;
  let waiting = 0;
  let idle = 0;
  let totalCpu = 0;
  let totalMem = 0;
  let totalProcs = 0;
  let totalAgents = 0;
  for (const { raw } of view) {
    if (raw.state === "busy") busy++;
    else if (raw.state === "waiting") waiting++;
    else if (raw.state === "idle") idle++;
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
  if (waiting) states.push(`${YELLOW}●${RESET} ${waiting} waiting`);
  if (idle) states.push(`${RED}●${RESET} ${idle} idle`);
  const summary = [
    `${DIM}Sessions:${RESET} ${states.join("  ") || view.length}` +
      (totalAgents ? `   ${CYAN}◆${RESET} ${totalAgents} subagents` : ""),
    `${DIM}Resources:${RESET} cpu ${totalCpu.toFixed(1)}%  mem ${formatMem(
      totalMem,
    )}  procs ${totalProcs}`,
  ];

  // widths use the plain cell text (color is added afterward); the state
  // column is just the 1-char dot, and tree columns also fit child values
  const widths = cols.map(({ key, header, min = 0 }) => {
    if (key === "state") return Math.max(1, header.length); // just the dot
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

  // a sub-process row: pid/mem/cpu/up aligned under the session's columns,
  // then a tree branch (in the state column) and the command name; the
  // whole row is dimmed so sessions stay the focus
  const childLine = (c: any, isLast: boolean) => {
    const stats = TREE_COLS.map((key) => {
      const i = cols.findIndex((col) => col.key === key);
      return pad(c[key], widths[i], cols[i].align === "r");
    }).join("  ");
    const branch = isLast ? "└─" : "├─";
    const used = visLen(stats) + 3 + branch.length; // 2-space sep + branch + space
    const room = Math.max(termCols - used, 8);
    const name =
      c.name.length > room ? `${c.name.slice(0, room - 1)}…` : c.name;
    return `${DIM}${stats}  ${branch} ${name}${RESET}`;
  };

  // a live sub-agent row: no process columns (it runs in-process), just a
  // cyan diamond at the tree position with the agent's model and context size
  const agentLine = (a: any) => {
    const blanks = TREE_COLS.map((key) => {
      const i = cols.findIndex((col) => col.key === key);
      return " ".repeat(widths[i]);
    }).join("  ");
    const model = a.model?.replace(/^claude-/, "") ?? "agent";
    const ctx = a.ctx != null ? formatTokens(a.ctx) : "?";
    let label = `◆ ${model} · ${ctx} ctx${a.activity ? ` · ${a.activity}` : ""}`;
    const room = Math.max(termCols - visLen(blanks) - 2, 8);
    if (label.length > room) label = `${label.slice(0, room - 1)}…`;
    return `${blanks}  ${CYAN}${label}${RESET}`;
  };

  // each group is a session row, then its live sub-agents, then its
  // sub-process rows, kept together so truncation never orphans them
  const groups: Group[] = view.map((r) => ({
    key: rowKey(r.raw),
    lines: [
      sessionLine(r.cells, r.raw),
      ...r.subagents.map(agentLine),
      ...r.children.map((c, i) => childLine(c, i === r.children.length - 1)),
    ],
  }));

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
  out.push(
    `${dot} ${BOLD}${shortProject(r.project)}${RESET}  ${DIM}${r.state}${RESET}`,
  );
  out.push("");
  out.push(`${label("session")}${r.sessionId ?? "-"}`);
  if (r.sessionName) out.push(`${label("name")}${r.sessionName}`);
  out.push(`${label("pid")}${r.pid}  ${DIM}·${RESET}  ${r.kind ?? "-"}`);
  out.push(`${label("project")}${r.project ?? "-"}`);
  out.push(`${label("branch")}${r.branch ?? "-"}`);
  const ctx =
    r.contextTokens != null
      ? (() => {
          const c = ctxColor(r.contextTokens);
          const s = formatTokens(r.contextTokens);
          return c ? heatNum(s, c) : s;
        })()
      : "-";
  out.push(
    `${label("model")}${r.model?.replace(/^claude-/, "") ?? "-"}  ${DIM}·${RESET}  ${ctx} ctx`,
  );
  out.push(`${label("version")}${r.version ?? "-"}`);
  out.push(`${label("host")}${r.host}`);
  const cpuC = cpuColor(r.cpu);
  const cpuStr = `${r.cpu.toFixed(1)}%`;
  out.push(
    `${label("cpu/mem")}${cpuC ? heatNum(cpuStr, cpuC) : cpuStr}  ${DIM}·${RESET}  ${formatMem(r.mem)}`,
  );
  out.push(
    `${label("uptime")}${formatDuration(r.uptimeSec)}  ${DIM}·${RESET}  last ${
      r.lastMs ? formatDuration((Date.now() - r.lastMs) / 1000) : "-"
    } ago`,
  );
  if (r.transcript) out.push(`${label("log")}${r.transcript}`);

  out.push("");
  out.push(`${BOLD}Prompt${RESET}`);
  out.push(...wrap(r.prompt ?? r.sessionName ?? "-", 2));

  if (r.subagents.length) {
    out.push("");
    out.push(`${BOLD}Sub-agents${RESET} ${DIM}(${r.subagents.length})${RESET}`);
    for (const a of r.subagents) {
      const model = a.model?.replace(/^claude-/, "") ?? "agent";
      const ac = a.ctx != null ? formatTokens(a.ctx) : "?";
      const line = `${CYAN}◆${RESET} ${model} · ${ac} ctx${
        a.activity ? ` · ${a.activity}` : ""
      }`;
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
      out.push(`${DIM}${stats}${RESET}  ${truncate(c.name, room)}`);
    }
  }
  return out;
}
