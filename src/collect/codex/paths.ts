// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// On-disk locations for the OpenAI Codex CLI, under ~/.codex. Read-only;
// nothing here writes. Unlike Claude's ~/.claude/projects/<mangled-cwd>/ layout,
// Codex stores every session as a rollout transcript under a flat, date-
// partitioned tree: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl.
// The cwd is not encoded in the path — it lives inside each rollout's
// session_meta line — so the resolver (rollout.ts) matches a running codex
// process to its rollout by start-time + cwd, not by a path built from the cwd.

import { homedir } from "node:os";

// Codex honors CODEX_HOME as a full override of the default ~/.codex (a single
// directory, with ~ expansion), the same way Claude honors CLAUDE_CONFIG_DIR.
// Resolved on each call (not cached at module load) so the tests can point it
// at a fixture tree by setting the env before invoking the resolver.
export function codexDir(): string {
  const override = process.env.CODEX_HOME?.trim();
  if (!override) return `${homedir()}/.codex`;
  if (override === "~") return homedir();
  if (override.startsWith("~/")) return `${homedir()}${override.slice(1)}`;
  return override;
}

// Rollout transcripts live under sessions/<YYYY>/<MM>/<DD>/.
export const sessionsRoot = () => `${codexDir()}/sessions`;
