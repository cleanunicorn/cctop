// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Shared on-disk locations under ~/.claude. Read-only; nothing here writes.

import { homedir } from "node:os";

// Claude Code honors CLAUDE_CONFIG_DIR as a *full* override of the default
// ~/.claude (a single directory, with ~ expansion) — when set, the session
// registry, transcripts, settings, and our own usage cache all live there.
// Match that exactly so cctop reads from the same place Claude wrote.
function resolveClaudeDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!override) return `${homedir()}/.claude`;
  if (override === "~") return homedir();
  if (override.startsWith("~/")) return `${homedir()}${override.slice(1)}`;
  return override;
}

export const CLAUDE_DIR = resolveClaudeDir();

// Transcripts live under a directory derived from the session's cwd
export const projectDir = (cwd: string) =>
  `${CLAUDE_DIR}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
