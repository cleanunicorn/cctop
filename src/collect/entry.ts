// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Minimal shapes over Claude Code's undocumented transcript JSONL. Only the
// fields cctop actually reads are named, everything is optional, and message
// content stays `unknown` so it is narrowed at each use site — a malformed or
// half-written line is handled by the readers, never typed into safety.

export interface TokenUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AssistantMessage {
  model?: string;
  usage?: TokenUsage;
  content?: unknown;
}

export interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
  message?: AssistantMessage;
}

// A turn's context window is fresh input plus both cache buckets. The main
// scanner and the sub-agent scanner report the same number, so the arithmetic
// lives in one place.
export const contextTokens = (u: TokenUsage | undefined): number =>
  (u?.input_tokens ?? 0) +
  (u?.cache_read_input_tokens ?? 0) +
  (u?.cache_creation_input_tokens ?? 0);
