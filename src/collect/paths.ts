// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Shared on-disk locations under ~/.claude. Read-only; nothing here writes.

import { homedir } from "node:os";

export const CLAUDE_DIR = `${homedir()}/.claude`;

// Transcripts live under a directory derived from the session's cwd
export const projectDir = (cwd: string) =>
  `${CLAUDE_DIR}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
