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
  sanitizeDisplay,
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
  // first column doubles as the tree gutter: a status dot on session rows, a
  // branch (├─/└─) on sub-process rows, a pipe (│) on sub-agent rows
  { key: "state", header: "S", align: "l" },
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
  // column is the tree gutter, 2 wide to fit the branch glyphs (├─/└─/│);
  // tree columns also fit child values
  const widths = cols.map(({ key, header, min = 0 }) => {
    if (key === "state") return 2; // dot or 2-char tree glyph
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

  // a live sub-agent row: a dimmed pipe (not a branch — it isn't a process) in
  // the tree gutter, then blank process columns except UP, which we derive
  // from the transcript's creation time so it still shows how long it has been
  // running; its context and model then line up under the parent's CTX/MODEL
  // columns (cyan marks it as a sub-agent), with the action flowing free after
  const ctxI = cols.findIndex((c) => c.key === "ctx");
  const modelI = cols.findIndex((c) => c.key === "model");
  const agentLine = (a: any) => {
    const branch = pad("│", widths[stateI]);
    const stats = TREE_COLS.map((key) => {
      const i = cols.findIndex((col) => col.key === key);
      if (key === "up" && a.uptimeSec != null)
        return pad(formatDuration(a.uptimeSec), widths[i], true);
      return " ".repeat(widths[i]);
    }).join("  ");
    const ctx = pad(
      a.ctx != null ? formatTokens(a.ctx) : "?",
      widths[ctxI],
      true,
    );
    const model = pad(shortModel(a.model) ?? "agent", widths[modelI], false);
    const prefix = `${branch}  ${stats}  ${ctx}  ${model}`;
    const room = Math.max(termCols - visLen(prefix) - 2, 8);
    let activity = a.activity ?? "";
    if (activity.length > room) activity = `${activity.slice(0, room - 1)}…`;
    const tail = activity ? `  ${activity}` : "";
    return `${DIM}${branch}  ${stats}${RESET}  ${CYAN}${ctx}  ${model}${tail}${RESET}`;
  };

  // a dim summary line that stands in for capped sub-agent/sub-process rows,
  // glyph in the tree gutter to match the rows it replaces
  const moreLine = (glyph: string, hidden: number, noun: string) =>
    `${DIM}${pad(glyph, widths[stateI])}  … +${hidden} more ${noun}${RESET}`;

  // each group is a session row, then its live sub-agents (pipe-marked), then
  // its sub-process tree (branch-marked), kept together so truncation never
  // orphans them. Each kind is capped so one busy session can't fill the view.
  const groups: Group[] = view.map((r) => {
    const lines = [sessionLine(r.cells, r.raw)];

    const agents = r.subagents.slice(0, MAX_SUBAGENT_ROWS);
    agents.forEach((a) => {
      lines.push(agentLine(a));
    });
    if (r.subagents.length > agents.length)
      lines.push(
        moreLine("│", r.subagents.length - agents.length, "sub-agents"),
      );

    const kids = r.children.slice(0, MAX_CHILD_ROWS);
    const capped = r.children.length > kids.length;
    kids.forEach((c, i) => {
      // when capped the overflow line is the closer, so no child gets └─
      lines.push(childLine(c, !capped && i === kids.length - 1));
    });
    if (capped)
      lines.push(moreLine("└─", r.children.length - kids.length, "processes"));

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
  out.push(
    `${dot} ${BOLD}${projectShort}${RESET}  ${DIM}${safe(r.state)}${RESET}`,
  );
  out.push("");
  out.push(`${label("session")}${safe(r.sessionId)}`);
  if (r.sessionName) out.push(`${label("name")}${safe(r.sessionName)}`);
  out.push(`${label("pid")}${r.pid}  ${DIM}·${RESET}  ${safe(r.kind)}`);
  out.push(`${label("project")}${safe(r.project)}`);
  out.push(`${label("branch")}${safe(r.branch)}`);
  const ctx =
    r.contextTokens != null
      ? (() => {
          const c = ctxColor(r.contextTokens);
          const s = formatTokens(r.contextTokens);
          return c ? heatNum(s, c) : s;
        })()
      : "-";
  out.push(
    `${label("model")}${safe(shortModel(r.model))}  ${DIM}·${RESET}  ${ctx} ctx`,
  );
  out.push(`${label("version")}${safe(r.version)}`);
  out.push(`${label("host")}${safe(r.host)}`);
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
  if (r.transcript) out.push(`${label("log")}${safe(r.transcript)}`);

  out.push("");
  out.push(`${BOLD}Prompt${RESET}`);
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
