// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive TUI runtime: an event-driven loop fed by a refresh timer and
// raw-mode keyboard input. Holds the app state (selection, mode, filter,
// sort), windows the table to the terminal, draws the detail/help/confirm
// overlays, and runs process actions (quit a session).

import { collectRows, matchRow, type Row } from "./collect.ts";
import {
  BLUE,
  BOLD,
  CYAN,
  clockTime,
  DIM,
  GREEN,
  RED,
  RESET,
  sanitizeDisplay,
  shortProject,
  truncate,
  visLen,
  YELLOW,
} from "./format.ts";
import { buildFrame, type Group, renderDetail, rowKey } from "./render.ts";

type Mode = "list" | "detail" | "filter" | "confirm" | "help";

interface ConfirmAction {
  row: Row;
  signal: "SIGTERM";
}

interface State {
  rows: Row[]; // all sessions, unfiltered, sorted by collectRows default
  mode: Mode;
  selectedKey: string | null;
  selectedIndex: number; // last known index, for clamping when a row vanishes
  filter: string | null; // active filter (lowercased)
  filterInput: string; // edit buffer while in filter mode
  sortIndex: number;
  scrollTop: number; // first visible group index (list)
  detailScroll: number; // first visible line (detail)
  message: string | null;
  messageColor: string;
  messageUntil: number;
  confirm: ConfirmAction | null;
}

interface SortMode {
  name: string;
  cmp: (a: Row, b: Row) => number;
}

const SORTS: SortMode[] = [
  {
    name: "default",
    cmp: (a, b) =>
      (a.state === "busy" ? 0 : 1) - (b.state === "busy" ? 0 : 1) ||
      b.lastMs - a.lastMs ||
      a.pid - b.pid,
  },
  { name: "cpu", cmp: (a, b) => b.cpu - a.cpu || a.pid - b.pid },
  { name: "mem", cmp: (a, b) => b.mem - a.mem || a.pid - b.pid },
  {
    name: "ctx",
    cmp: (a, b) =>
      (b.contextTokens ?? 0) - (a.contextTokens ?? 0) || a.pid - b.pid,
  },
  { name: "pid", cmp: (a, b) => a.pid - b.pid },
];

// blue so it stays distinct from the green/red state dots and cyan sub-agents
const SELBAR = `${BLUE}▌${RESET} `; // left bar marking the selected group
const GUTTER = "  "; // matching width for unselected rows + header

export interface AppOptions {
  filter: string | null;
  watchSecs: number;
  version: string;
}

export async function runApp(opts: AppOptions): Promise<void> {
  const out = process.stdout;
  const state: State = {
    rows: [],
    mode: "list",
    selectedKey: null,
    selectedIndex: 0,
    filter: opts.filter,
    filterInput: "",
    sortIndex: 0,
    scrollTop: 0,
    detailScroll: 0,
    message: null,
    messageColor: DIM,
    messageUntil: 0,
    confirm: null,
  };

  // --- terminal setup / teardown ------------------------------------------
  // Alt screen (like top), hidden cursor, focus reporting off (we never read
  // those events; if the terminal has it on they leak as \x1b[I/\x1b[O).
  out.write("\x1b[?1004l\x1b[?1049h\x1b[?25l\x1b[H");
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      process.stdin.setRawMode?.(false);
    } catch {}
    out.write("\x1b[?25h\x1b[?1049l\x1b[?1004l");
  };
  process.on("exit", restore);
  const quit = () => {
    restore();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  // --- selection helpers ---------------------------------------------------
  const activeFilter = () =>
    state.mode === "filter"
      ? state.filterInput.toLowerCase() || null
      : state.filter;

  const displayRows = (): Row[] =>
    state.rows
      .filter((r) => matchRow(r, activeFilter()))
      .sort(SORTS[state.sortIndex].cmp);

  const selectedRow = (rows: Row[]): Row | null => {
    if (!rows.length) return null;
    const i = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    return i >= 0
      ? rows[i]
      : rows[Math.min(state.selectedIndex, rows.length - 1)];
  };

  // After data/filter/sort changes, keep the cursor on the same session if it
  // is still present; otherwise clamp to the nearest surviving index.
  const reconcile = (rows: Row[]) => {
    if (!rows.length) {
      state.selectedKey = null;
      state.selectedIndex = 0;
      return;
    }
    let i = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    if (i < 0) i = Math.min(state.selectedIndex, rows.length - 1);
    state.selectedIndex = i;
    state.selectedKey = rowKey(rows[i]);
  };

  const move = (delta: number) => {
    const rows = displayRows();
    if (!rows.length) return;
    let i = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    if (i < 0) i = state.selectedIndex;
    i = Math.max(0, Math.min(rows.length - 1, i + delta));
    state.selectedIndex = i;
    state.selectedKey = rowKey(rows[i]);
  };

  const jump = (to: "top" | "bottom") => {
    const rows = displayRows();
    if (!rows.length) return;
    const i = to === "top" ? 0 : rows.length - 1;
    state.selectedIndex = i;
    state.selectedKey = rowKey(rows[i]);
  };

  const flash = (msg: string, color = DIM) => {
    state.message = msg;
    state.messageColor = color;
    state.messageUntil = Date.now() + 4000;
  };

  // --- data refresh --------------------------------------------------------
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      state.rows = await collectRows(null); // collect all; filter in-app
    } finally {
      refreshing = false;
    }
    reconcile(displayRows());
    draw();
  };

  // --- actions -------------------------------------------------------------
  const sameSignalTarget = (a: Row, b: Row) =>
    a.pid === b.pid && rowKey(a) === rowKey(b) && a.startSec === b.startSec;

  const doQuit = async (action: ConfirmAction) => {
    const { row, signal } = action;
    let rows: Row[];
    try {
      rows = await collectRows(null);
    } catch (e: any) {
      flash(
        `could not refresh sessions: ${sanitizeDisplay(e?.message ?? "failed")}`,
        RED,
      );
      return;
    }
    state.rows = rows;
    const current = rows.find((r) => sameSignalTarget(r, row));
    if (!current) {
      const id = row.sessionId ? row.sessionId.slice(0, 8) : `pid ${row.pid}`;
      flash(`session ${sanitizeDisplay(id)} is no longer running`, YELLOW);
      return;
    }
    try {
      process.kill(current.pid, signal);
      flash(
        `sent ${signal} to ${current.pid} (${sanitizeDisplay(shortProject(current.project))})`,
        GREEN,
      );
    } catch (e: any) {
      const why =
        e?.code === "ESRCH"
          ? "already gone"
          : e?.code === "EPERM"
            ? "permission denied"
            : sanitizeDisplay(e?.message ?? "failed");
      flash(`could not signal ${current.pid}: ${why}`, RED);
    }
  };

  // --- input ---------------------------------------------------------------
  const onListKey = (k: string) => {
    switch (k) {
      case "up":
      case "k":
        move(-1);
        break;
      case "down":
      case "j":
        move(1);
        break;
      case "pageup":
        move(-10);
        break;
      case "pagedown":
        move(10);
        break;
      case "g":
      case "home":
        jump("top");
        break;
      case "G":
      case "end":
        jump("bottom");
        break;
      case "enter":
        if (selectedRow(displayRows())) {
          state.mode = "detail";
          state.detailScroll = 0;
        }
        break;
      case "/":
        state.mode = "filter";
        state.filterInput = state.filter ?? "";
        break;
      case "s":
        state.sortIndex = (state.sortIndex + 1) % SORTS.length;
        flash(`sort: ${SORTS[state.sortIndex].name}`);
        break;
      case "x": {
        const row = selectedRow(displayRows());
        if (row) {
          state.confirm = { row, signal: "SIGTERM" };
          state.mode = "confirm";
        }
        break;
      }
      case "?":
        state.mode = "help";
        break;
      case "q":
        quit();
        return;
    }
    draw();
  };

  const onDetailKey = (k: string) => {
    switch (k) {
      case "up":
      case "k":
        state.detailScroll = Math.max(0, state.detailScroll - 1);
        break;
      case "down":
      case "j":
        state.detailScroll += 1;
        break;
      case "pageup":
        state.detailScroll = Math.max(0, state.detailScroll - 10);
        break;
      case "pagedown":
        state.detailScroll += 10;
        break;
      case "x": {
        const row = selectedRow(displayRows());
        if (row) {
          state.confirm = { row, signal: "SIGTERM" };
          state.mode = "confirm";
        }
        break;
      }
      case "escape":
      case "q":
        state.mode = "list";
        break;
    }
    draw();
  };

  const onFilterKey = (k: string) => {
    if (k === "enter") {
      state.filter = state.filterInput.toLowerCase() || null;
      state.mode = "list";
    } else if (k === "escape") {
      state.filterInput = "";
      state.mode = "list";
    } else if (k === "backspace") {
      state.filterInput = state.filterInput.slice(0, -1);
    } else if (k.length === 1 && k >= " " && k !== "\x7f") {
      state.filterInput += k;
    }
    reconcile(displayRows());
    draw();
  };

  const onConfirmKey = async (k: string) => {
    if (k === "y" || k === "Y") {
      const action = state.confirm;
      state.confirm = null;
      state.mode = "list";
      if (action) await doQuit(action);
    } else if (k === "n" || k === "N" || k === "escape" || k === "q") {
      state.confirm = null;
      state.mode = "list";
    }
    draw();
  };

  const onHelpKey = (k: string) => {
    if (k === "escape" || k === "q" || k === "?") state.mode = "list";
    draw();
  };

  // Map a recognized escape sequence to a logical key name.
  const seqName = (s: string): string => {
    switch (s) {
      case "\x1b[A":
      case "\x1bOA":
        return "up";
      case "\x1b[B":
      case "\x1bOB":
        return "down";
      case "\x1b[C":
      case "\x1bOC":
        return "right";
      case "\x1b[D":
      case "\x1bOD":
        return "left";
      case "\x1b[5~":
        return "pageup";
      case "\x1b[6~":
        return "pagedown";
      case "\x1b[H":
      case "\x1b[1~":
        return "home";
      case "\x1b[F":
      case "\x1b[4~":
        return "end";
      default:
        return ""; // unknown sequence: ignore
    }
  };

  const charName = (c: string): string => {
    switch (c) {
      case "\r":
      case "\n":
        return "enter";
      case "\x7f":
      case "\b":
        return "backspace";
      case "\x1b":
        return "escape";
      case "\x03":
        return "ctrl-c";
      default:
        return c;
    }
  };

  // A single read can carry several keypresses (fast typing, or input buffered
  // while the first frame renders) and/or multi-byte escape sequences. Split a
  // chunk into individual logical keys, keeping CSI/SS3 sequences whole.
  const parseKeys = (data: string): string[] => {
    const keys: string[] = [];
    let i = 0;
    while (i < data.length) {
      const c = data[i];
      if (c === "\x1b" && i + 1 < data.length) {
        const next = data[i + 1];
        if (next === "O" && i + 2 < data.length) {
          keys.push(seqName(data.slice(i, i + 3)) || "");
          i += 3;
          continue;
        }
        if (next === "[") {
          let j = i + 2;
          while (j < data.length && !(data[j] >= "@" && data[j] <= "~")) j++;
          keys.push(seqName(data.slice(i, j + 1)) || "");
          i = j + 1;
          continue;
        }
      }
      keys.push(charName(c));
      i += 1;
    }
    return keys.filter(Boolean);
  };

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    for (const k of parseKeys(data)) {
      if (k === "ctrl-c") return quit();
      switch (state.mode) {
        case "list":
          onListKey(k);
          break;
        case "detail":
          onDetailKey(k);
          break;
        case "filter":
          onFilterKey(k);
          break;
        case "confirm":
          void onConfirmKey(k);
          break;
        case "help":
          onHelpKey(k);
          break;
      }
    }
  });

  out.on("resize", () => draw());

  // --- rendering -----------------------------------------------------------
  function draw() {
    const cols = out.columns || 200;
    const rows = out.rows || 40;
    const lines =
      state.mode === "help"
        ? helpScreen(rows, opts)
        : state.mode === "detail"
          ? detailScreen(cols, rows)
          : listScreen(cols, rows);
    const frame = lines.map((l) => `${l}\x1b[K`).join("\n");
    out.write(`\x1b[?2026h\x1b[H${frame}\x1b[J\x1b[?2026l`);
  }

  // Fit a clip to height: returns the visible slice plus scroll indicators,
  // padded to exactly `height` lines. `scroll` is the first visible line.
  function clipLines(
    body: string[],
    height: number,
    scroll: number,
  ): { lines: string[]; scroll: number } {
    if (body.length <= height) {
      return {
        lines: [...body, ...Array(height - body.length).fill("")],
        scroll: 0,
      };
    }
    const top = Math.max(0, Math.min(scroll, body.length - height));
    const out: string[] = [];
    const hasUp = top > 0;
    const hasDown = top + height < body.length;
    const innerH = height - (hasUp ? 1 : 0) - (hasDown ? 1 : 0);
    if (hasUp) out.push(`${DIM}  ↑ ${top} more${RESET}`);
    out.push(...body.slice(top, top + innerH));
    if (hasDown)
      out.push(`${DIM}  ↓ ${body.length - top - innerH} more${RESET}`);
    while (out.length < height) out.push("");
    return { lines: out, scroll: top };
  }

  function listScreen(cols: number, termRows: number): string[] {
    const rows = displayRows();
    const top = [...summaryLines(rows), ""];
    const footer = footerLine(cols);
    const region = Math.max(
      termRows - top.length - 1 /*header*/ - 1 /*footer*/,
      1,
    );

    if (!rows.length) {
      const filter = activeFilter();
      const msg = filter
        ? `no Claude Code sessions match "${sanitizeDisplay(filter)}"`
        : "no Claude Code sessions running";
      const body = [`${DIM}${msg}${RESET}`, ...Array(region - 1).fill("")];
      return [
        ...top,
        GUTTER + headerOnly(cols),
        ...body.slice(0, region),
        footer,
      ];
    }

    const frame = buildFrame(rows, cols - GUTTER.length);
    const selIdx = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    const body = windowGroups(frame.groups, selIdx, region);
    return [...top, GUTTER + frame.header, ...body, footer];
  }

  // Window the session groups to `budget` lines, keeping the selected group
  // visible, applying the selection bar, and adding scroll indicators.
  function windowGroups(
    groups: Group[],
    selIdx: number,
    budget: number,
  ): string[] {
    const n = groups.length;
    const fitFrom = (start: number): number[] => {
      let avail = budget - (start > 0 ? 1 : 0); // reserve up-indicator
      const idxs: number[] = [];
      for (let i = start; i < n; i++) {
        const reserve = i < n - 1 ? 1 : 0; // possible down-indicator
        if (idxs.length && groups[i].lines.length + reserve > avail) break;
        idxs.push(i);
        avail -= groups[i].lines.length;
      }
      return idxs;
    };

    let top = state.scrollTop;
    if (top > selIdx) top = selIdx;
    if (top < 0) top = 0;
    let idxs = fitFrom(top);
    while (selIdx >= 0 && !idxs.includes(selIdx) && top < n - 1) {
      top += 1;
      idxs = fitFrom(top);
    }
    state.scrollTop = top;

    const lines: string[] = [];
    if (top > 0) lines.push(`${DIM}  ↑ ${top} more above${RESET}`);
    for (const i of idxs) {
      const selected = i === selIdx;
      for (const line of groups[i].lines)
        lines.push((selected ? SELBAR : GUTTER) + line);
    }
    const below = n - (idxs.length ? idxs[idxs.length - 1] + 1 : top);
    if (below > 0) lines.push(`${DIM}  ↓ ${below} more below${RESET}`);
    while (lines.length < budget) lines.push("");
    return lines.slice(0, budget);
  }

  function detailScreen(cols: number, termRows: number): string[] {
    const rows = displayRows();
    const row = selectedRow(rows);
    if (!row) {
      state.mode = "list";
      return listScreen(cols, termRows);
    }
    const footer = footerLine(cols);
    const region = Math.max(termRows - 1, 1);
    const body = renderDetail(row, cols - 2).map((l) => `  ${l}`);
    const clipped = clipLines(body, region, state.detailScroll);
    state.detailScroll = clipped.scroll;
    return [...clipped.lines, footer];
  }

  function helpScreen(termRows: number, o: AppOptions): string[] {
    const b = (s: string) => `${BOLD}${s}${RESET}`;
    const key = (k: string, d: string) =>
      `  ${CYAN}${k.padEnd(12)}${RESET}${d}`;
    const body = [
      `${b("cctop")} ${DIM}${o.version}${RESET}`,
      "",
      b("Navigation"),
      key("↑ / k", "move up"),
      key("↓ / j", "move down"),
      key("PgUp/PgDn", "jump 10 rows"),
      key("g / G", "top / bottom"),
      key("enter", "open detail view"),
      key("esc", "back / close overlay"),
      "",
      b("View"),
      key("/", "filter sessions (type, enter to apply)"),
      key("s", "cycle sort (default, cpu, mem, ctx, pid)"),
      key("?", "toggle this help"),
      "",
      b("Actions"),
      key("x", "quit selected session (SIGTERM, confirm)"),
      "",
      b("Exit"),
      key("q / Ctrl-C", "quit cctop"),
    ];
    const footer = `${DIM}press any of esc / q / ? to return${RESET}`;
    const region = Math.max(termRows - 1, 1);
    const clipped = clipLines(
      body.map((l) => `  ${l}`),
      region,
      0,
    );
    return [...clipped.lines, footer];
  }

  function summaryLines(rows: Row[]): string[] {
    // Reuse buildFrame's summary for the (filtered) rows; if empty, a stub.
    if (!rows.length)
      return [
        `${DIM}Sessions:${RESET} 0`,
        `${DIM}Resources:${RESET} cpu 0.0%  mem 0M  procs 0`,
      ];
    return buildFrame(rows, (out.columns || 200) - GUTTER.length).summary;
  }

  function headerOnly(cols: number): string {
    return buildFrame([], cols - GUTTER.length).header;
  }

  function footerLine(cols: number): string {
    if (state.mode === "filter") {
      const cursor = `${CYAN}▏${RESET}`;
      return truncate(
        `${BOLD}/${RESET}${sanitizeDisplay(state.filterInput)}${cursor}  ${DIM}enter apply · esc cancel${RESET}`,
        cols + 999, // keep ANSI; filter input is short
      );
    }
    if (state.mode === "confirm" && state.confirm) {
      const { row, signal } = state.confirm;
      const id = sanitizeDisplay(
        row.sessionId ? row.sessionId.slice(0, 8) : `pid ${row.pid}`,
      );
      const project = sanitizeDisplay(shortProject(row.project));
      return `${YELLOW}Quit ${project} (${id}) with ${signal}?${RESET}  ${BOLD}${GREEN}y${RESET}es / ${BOLD}${RED}n${RESET}o`;
    }
    if (state.message) {
      return `${state.messageColor}${state.message}${RESET}`;
    }
    const sort = SORTS[state.sortIndex].name;
    const hint =
      state.mode === "detail"
        ? "↑↓ scroll · esc back · x quit session · q exit"
        : `↑↓ move · enter detail · / filter · s sort:${sort} · x quit · ? help · q exit`;
    const left = `${DIM}cctop/${opts.version} · every ${opts.watchSecs}s · ${clockTime()}${RESET}`;
    const line = `${left}  ${DIM}·${RESET}  ${DIM}${hint}${RESET}`;
    return visLen(line) > cols
      ? `${DIM}${truncateVisible(hint, cols)}${RESET}`
      : line;
  }

  // --- start ---------------------------------------------------------------
  await refresh();
  setInterval(() => {
    // clear an expired transient message on the natural refresh cadence
    refresh();
  }, opts.watchSecs * 1000);
  // a lightweight clock/message tick so the footer time stays current and
  // flashes clear even between data refreshes
  setInterval(() => {
    if (state.message && Date.now() > state.messageUntil) state.message = null;
    draw();
  }, 1000);
}

// Truncate a plain (no-ANSI) string to a visible width with an ellipsis.
function truncateVisible(s: string, width: number): string {
  return s.length <= width ? s : truncate(s, width);
}
