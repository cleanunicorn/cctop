// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Formatting helpers and ANSI utilities shared by the table and detail views.

import { homedir } from "node:os";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const REVERSE = "\x1b[7m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const GREEN = "\x1b[32m";
export const BRIGHT_GREEN = "\x1b[92m";
export const CYAN = "\x1b[36m";

// Cells carry color codes inline, so width and padding must count only the
// visible characters, not the escape sequences.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const visLen = (s: string) => s.replace(ANSI_RE, "").length;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");
export const pad = (s: string, w: number, right?: boolean) => {
  const gap = Math.max(0, w - visLen(s));
  return right ? " ".repeat(gap) + s : s + " ".repeat(gap);
};
// heat-color a value (number and unit alike): "90k" -> all green
export const heatNum = (s: string, color: string) => `${color}${s}${RESET}`;

export function formatMem(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

// 24-hour HH:MM:SS, locale-independent
export function clockTime() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatTokens(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// Compact: just the largest unit (at most 3 chars): 45s, 12m, 4h, 9d
export function formatDuration(sec: number) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Keep the project recognizable but short: just its last path segment
export function shortProject(cwd: string | null) {
  if (!cwd) return "?";
  if (cwd === homedir()) return "~";
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

// busy/idle shown as a status dot rather than a word
export const stateDot = (state: string) =>
  state === "busy"
    ? `${BRIGHT_GREEN}●${RESET}` // actively working
    : state === "waiting"
      ? `${YELLOW}●${RESET}` // waiting on a tool/sub-agent
      : state === "idle"
        ? `${RED}●${RESET}` // waiting on you
        : `${DIM}·${RESET}`;

// CPU% and context fill warm toward red as they climb; low values stay plain
export const cpuColor = (v: number) =>
  v >= 80 ? RED : v >= 40 ? YELLOW : null;
export const ctxColor = (v: number) =>
  v >= 400_000 ? RED : v >= 200_000 ? YELLOW : null;

// Truncate to a visible width, adding an ellipsis. Assumes no ANSI in `s`.
export function truncate(s: string, width: number) {
  if (s.length <= width) return s;
  return width <= 1 ? s.slice(0, width) : `${s.slice(0, width - 1)}…`;
}
