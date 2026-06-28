// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// ANSI rendering for the session history dashboard: a per-day activity bar
// chart as the headline graph, then compact text rows for token volume and
// model/tool/project composition. Pure functions over an already-aggregated
// History (collect/history.ts); the interactive runtime (app.ts) layers
// scrolling on top, exactly as it does for the detail view.

import type { History } from "./collect/history.ts";
import {
  BOLD,
  DIM,
  GREEN,
  pad,
  RESET,
  truncate,
  truncateStart,
  truncateStyled,
  visLen,
} from "./format.ts";

// --- formatting helpers -----------------------------------------------------

// Compact magnitude for token counts: 1.2B / 3.4M / 56k / 789.
export function big(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

const shortModel = (m: string) =>
  m.replace(/^claude-/, "").replace(/-\d{8}$/, "");

const heading = (s: string) => `${BOLD}${s}${RESET}`;

// Vertical eighth-blocks for the per-day bar chart: index 1..7 are partial cells
// (▁..▇) filling a row from the bottom; a full cell is "█".
const VBLOCK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];

const HISTORY_DAYS = 30; // Claude keeps ~30 days (cleanupPeriodDays); show them all
const CHART_H = 7; // bar-chart height in rows
const HEAD_W = 9; // text-row heading column ("Projects" + a space)

const LABEL_MAX = 16; // default name cap for the narrow (side-by-side) lists

// An aligned name/value list: a bold heading on the first row, then one row per
// item — the name in normal weight (not gray) and its value dimmed beside it.
// Shared by the Models / Tools / Projects sections. With `width` the names fill
// the whole row (capped to what's left after the value); `front` truncates names
// from the left (keeping the meaningful tail, e.g. of long mcp tool ids).
function alignedList(
  title: string,
  rows: { label: string; value: string }[],
  opts: { width?: number; front?: boolean } = {},
): string[] {
  if (!rows.length) return [];
  const valueW = Math.max(...rows.map((r) => visLen(r.value)));
  const max = opts.width
    ? Math.max(1, opts.width - HEAD_W - valueW - 2)
    : LABEL_MAX;
  const cut = opts.front ? truncateStart : truncate;
  const labels = rows.map((r) => cut(r.label, max));
  const labelW = Math.max(...labels.map(visLen));
  return rows.map((r, i) => {
    const head =
      i === 0 ? `${BOLD}${pad(title, HEAD_W)}${RESET}` : " ".repeat(HEAD_W);
    return `${head}${pad(labels[i], labelW)}  ${DIM}${pad(r.value, valueW, true)}${RESET}`;
  });
}

const pctStr = (frac: number) =>
  `${frac >= 0.01 ? Math.round(frac * 100) : "<1"}%`;

// The last `n` path segments of a cwd, e.g. ".../controlplaneio/flux-operator".
const lastDirs = (path: string, n: number) =>
  path.split("/").filter(Boolean).slice(-n).join("/") || path;

// --- the activity chart -----------------------------------------------------

// "MM/DD" for a YYYY-MM-DD date string (e.g. 2026-06-08 → "06/08").
const monthDay = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;
const DATE_W = 5; // width of an "MM/DD" label

// A day's bar height in eighths of a cell (0..CHART_H*8), scaled to the busiest
// day. A day with any activity always rounds up to at least one eighth, so a
// single huge day can't scale every smaller day down to a blank column.
export function barEighths(turns: number, max: number): number {
  if (turns <= 0) return 0;
  return Math.max(1, Math.round((turns / Math.max(1, max)) * CHART_H * 8));
}

// Per-day vertical bar chart: one bar per day over the last 30 days, scaled to
// the busiest day and drawn with eighth-block precision. This is the dashboard's
// headline graph — sized to Claude Code's ~30-day transcript retention (see
// cleanupPeriodDays), with a left value axis and a date axis of evenly spaced
// MM/DD ticks below. Bars are widened to fill the available width (with a gap
// between days) so the chart breathes, and narrowed back when space is tight.
function activity(h: History, width: number): string[] {
  const all = h.days.slice(-HISTORY_DAYS);
  if (!all.length) return [];
  const max = Math.max(1, ...all.map((d) => d.turns));
  const labelW = String(max).length; // value-axis gutter
  const gutter = (s: string) => `${DIM}${pad(s, labelW, true)}${RESET}`;

  // Never draw more days than there are columns after the gutter, dropping the
  // oldest first, so the bars can't overflow (and wrap) on a narrow terminal.
  const room = Math.max(1, width - labelW - 1);
  const shown = all.slice(-Math.min(all.length, room));
  const n = shown.length;

  const eighths = shown.map((d) => barEighths(d.turns, max));

  // Fit a per-day stride (bar + gap) to the room left after the gutter. Aim for
  // 3-wide bars; drop the gap, then thin the bar, when a narrow terminal can't
  // afford it. stride = barW + gap, so each day occupies `stride` columns.
  const stride = Math.max(1, Math.min(4, Math.floor(room / n)));
  const gap = stride >= 2 ? 1 : 0;
  const barW = stride - gap;
  const span = n * barW + (n - 1) * gap; // total bar-area width

  // Value-axis ticks: the peak at the top row, ~half at the middle, 0 at the
  // baseline — each marked with a ┤ on the axis.
  const midRow = (CHART_H - 1) >> 1;
  const yLabel = (r: number) =>
    r === 0 ? String(max) : r === midRow ? String(Math.round(max / 2)) : "";

  const out = [
    `${heading("Activity")}  ${DIM}turns / day · last ${n}d${RESET}`,
    "",
  ];
  for (let r = 0; r < CHART_H; r++) {
    const fromBottom = CHART_H - 1 - r; // 0 at the baseline row
    const bars = eighths
      .map((e) => {
        const rem = e - fromBottom * 8;
        const g = rem <= 0 ? " " : rem >= 8 ? "█" : VBLOCK[rem];
        return g === " "
          ? " ".repeat(barW)
          : `${GREEN}${g.repeat(barW)}${RESET}`;
      })
      .join(" ".repeat(gap));
    out.push(
      `${gutter(yLabel(r))}${DIM}${yLabel(r) ? "┤" : "│"}${RESET}${bars}`,
    );
  }
  // Date axis: a few evenly spaced MM/DD labels (always including the last day),
  // each marked with a ┬ tick on the baseline and centered beneath it.
  const center = (i: number) => i * stride + ((barW - 1) >> 1);
  const minStep = Math.ceil((DATE_W + 1) / stride); // labels must not overlap
  let step = Math.max(minStep, Math.ceil(n / 6));
  for (const nice of [1, 2, 5, 7, 10, 14, 30])
    if (nice >= step) {
      step = nice;
      break;
    }
  const ticks: number[] = [];
  for (let i = 0; i < n; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== n - 1) {
    while (ticks.length > 1 && n - 1 - ticks[ticks.length - 1] < step)
      ticks.pop();
    ticks.push(n - 1);
  }

  const baseline = new Array(span).fill("─");
  const axis = new Array(span).fill(" ");
  for (const i of ticks) {
    const c = center(i);
    baseline[c] = "┬";
    const text = monthDay(shown[i].date);
    const s = Math.max(0, Math.min(c - (DATE_W >> 1), span - DATE_W));
    for (let k = 0; k < DATE_W; k++) axis[s + k] = text[k];
  }
  out.push(`${gutter("")}${DIM}└${baseline.join("")}${RESET}`);
  out.push(`${" ".repeat(labelW + 1)}${DIM}${axis.join("")}${RESET}`);
  return out;
}

// --- composition (compact text) ---------------------------------------------

const TOP_MODELS = 6;
const TOP_TOOLS = 8;
const TOP_PROJECTS = 8;

// Tokens broken down as an aligned mini-table: the input total, then the three
// input classes with their share of input (cache read is the cost signal — a
// high read share means most input was cheap cache hits), then output.
function tokensSection(h: History): string[] {
  let fresh = 0;
  let read = 0;
  let create = 0;
  let output = 0;
  for (const d of h.days) {
    fresh += d.inputFresh;
    read += d.cacheRead;
    create += d.cacheCreate;
    output += d.output;
  }
  const input = fresh + read + create;
  const share = (v: number) => {
    if (input <= 0) return "";
    const p = (v / input) * 100;
    return `${p >= 1 ? Math.round(p) : "<1"}%`;
  };
  const rows = [
    { label: "input", value: big(input), pct: "" },
    { label: "cache read", value: big(read), pct: share(read) },
    { label: "cache write", value: big(create), pct: share(create) },
    { label: "fresh", value: big(fresh), pct: share(fresh) },
    { label: "output", value: big(output), pct: "" },
  ];
  const labelW = Math.max(...rows.map((r) => r.label.length));
  const valueW = Math.max(...rows.map((r) => r.value.length));
  const pctW = Math.max(...rows.map((r) => r.pct.length));
  return rows.map((r, i) => {
    const head =
      i === 0 ? `${BOLD}${pad("Tokens", HEAD_W)}${RESET}` : " ".repeat(HEAD_W);
    const pct = r.pct ? `  ${DIM}${pad(r.pct, pctW, true)}${RESET}` : "";
    return `${head}${pad(r.label, labelW)} ${pad(r.value, valueW, true)}${pct}`;
  });
}

// Model mix (name + share of model tokens) as an aligned list.
function modelsSection(h: History): string[] {
  const total = [...h.byModel.values()].reduce((s, t) => s + t.tokens, 0) || 1;
  const rows = [...h.byModel.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, TOP_MODELS)
    .map(([m, t]) => ({
      label: shortModel(m) ?? m,
      value: pctStr(t.tokens / total),
    }));
  return alignedList("Models", rows);
}

// Lay two rendered blocks side by side, left padded to its visible width; falls
// back to stacking them when they wouldn't both fit the terminal width.
function sideBySide(left: string[], right: string[], width: number): string[] {
  const leftW = Math.max(0, ...left.map(visLen));
  const rightW = Math.max(0, ...right.map(visLen));
  if (!right.length) return left;
  if (leftW + 4 + rightW > width) return [...left, "", ...right];
  const rowsN = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rowsN; i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    out.push(r ? `${pad(l, leftW)}    ${r}` : l);
  }
  return out;
}

// Tool-use frequency (name + call count). Full-width rows; long tool ids (mcp…)
// are cut from the front so the distinctive tail stays visible.
function toolsSection(h: History, width: number): string[] {
  const rows = [...h.byTool.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TOOLS)
    .map(([name, n]) => ({ label: name, value: String(n) }));
  return alignedList("Tools", rows, { width, front: true });
}

// Per-project token volume. Full-width rows; the project is named by its last
// two path segments, cut from the front if still too long.
function projectsSection(h: History, width: number): string[] {
  const rows = [...h.byProject.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, TOP_PROJECTS)
    .map(([p, t]) => ({ label: lastDirs(p, 2), value: big(t.tokens) }));
  return alignedList("Projects", rows, { width, front: true });
}

function composition(h: History, width: number): string[] {
  // Tokens | Models sit in parallel columns; Tools and Projects each take a
  // full-width block (their names are long).
  return [
    ...sideBySide(tokensSection(h), modelsSection(h), width),
    "",
    ...toolsSection(h, width),
    "",
    ...projectsSection(h, width),
  ];
}

// --- entry point ------------------------------------------------------------

export function renderHistory(h: History, termCols: number): string[] {
  const width = Math.max(termCols, 20);
  if (!h.days.length) {
    return [
      heading("Session history"),
      "",
      `${DIM}No transcript history found under ~/.claude/projects${RESET}`,
    ];
  }
  const t = h.totals;
  const summary =
    `${big(t.tokens)} tokens ${DIM}·${RESET} ${big(t.turns)} turns ` +
    `${DIM}·${RESET} ${t.sessions} sessions ${DIM}·${RESET} ${t.subAgents} sub-agents`;
  const out: string[] = [
    heading("Session history"),
    "",
    truncateStyled(summary, width),
    "",
  ];
  out.push(...activity(h, width), "");
  out.push(...composition(h, width));
  return out;
}

// Exported for tests only.
export const __test = { big, barEighths };
