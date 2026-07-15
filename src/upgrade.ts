// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// `cctop upgrade` — the one path that reaches the network and rewrites cctop's
// own file on disk. The monitor itself stays read-only, offline, and
// subprocess-free (see AGENTS.md); this is a separate mode the user opts into
// by running the `upgrade` subcommand, never something the refresh loop does.
//
// When cctop is the compiled standalone binary it downloads the matching
// release for this OS/arch from GitHub Releases, verifies its SHA-256 against
// the published checksums, and swaps itself in place atomically. A source or
// `bun install -g` install has no single binary to swap, so it prints the exact
// command that updates that kind of install instead.

import { chmodSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { isCompiledBinary } from "./binary.ts";
import { BOLD, DIM, GREEN, RED, RESET } from "./format.ts";

// Where releases live. Overridable so forks (and tests) can point elsewhere
// without touching the code; defaults to the canonical repo the README installs
// from.
const REPO = process.env.CCTOP_REPO?.trim() || "stefanprodan/cctop";
const RELEASES = `https://github.com/${REPO}/releases`;
const GITHUB_HEADERS = { "user-agent": "cctop" };

// A real cctop binary is tens of MB; anything smaller is a truncated or wrong
// download, so refuse to install it.
const MIN_BINARY_BYTES = 1_000_000;
// ustar archives are a sequence of 512-byte blocks (one header, then padded data).
const TAR_BLOCK = 512;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A malformed override lands in the URL path (the scheme+host are hardcoded, so
// it can't redirect the host) — but it would otherwise fail as a confusing 404.
// Reject it up front with a clear message. Defense-in-depth, not a trust border.
export function assertValidOverrides(): void {
  const repo = process.env.CCTOP_REPO?.trim();
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(`invalid CCTOP_REPO "${repo}" (expected "owner/name")`);
  const version = process.env.CCTOP_VERSION?.trim();
  if (version && !/^v?\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version))
    throw new Error(
      `invalid CCTOP_VERSION "${version}" (expected e.g. v0.5.0)`,
    );
}

// --- Pure helpers (exported for the unit tests) --------------------------

// Release asset names mirror .github/workflows/release.yml:
//   cctop_<os>_<arch>.tar.gz  for os in {darwin,linux}, arch in {amd64,arm64}
export function assetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const os =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !cpu)
    throw new Error(
      `unsupported platform ${platform}/${arch} — cctop ships binaries for ` +
        `Linux and macOS on amd64/arm64 only`,
    );
  return `cctop_${os}_${cpu}.tar.gz`;
}

// Compare two vX.Y.Z(-pre) tags: 1 if a>b, -1 if a<b, 0 if equal. A prerelease
// (…-rc.1) sorts below its release; enough to answer "is the release newer than
// what I'm running".
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.replace(/^v/, "");
    const dash = s.indexOf("-");
    const core = dash < 0 ? s : s.slice(0, dash);
    const pre = dash < 0 ? "" : s.slice(dash + 1);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // 1.0.0 > 1.0.0-rc.1
  if (pb.pre === "") return -1;
  return comparePre(pa.pre, pb.pre);
}

// Compare two prerelease strings (rc.2 vs rc.10) by dot-separated identifiers:
// numeric identifiers compare numerically (so rc.10 > rc.2), others lexically;
// a prerelease that is a prefix of a longer one sorts lower.
function comparePre(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = i < as.length ? as[i] : undefined;
    const y = i < bs.length ? bs[i] : undefined;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const d = Number.parseInt(x, 10) - Number.parseInt(y, 10);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// …/releases/latest 302-redirects to …/releases/tag/<tag>; pull the tag out of
// the Location header.
export function tagFromLocation(location: string | null): string | null {
  if (!location) return null;
  const m = location.match(/\/releases\/tag\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// sha256sum output is "<hex>  <filename>" per line (the "*" marks a binary-mode
// entry). Return the hex recorded for `asset`.
export function parseChecksums(text: string, asset: string): string | null {
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return null;
}

// Minimal ustar reader: walk 512-byte header blocks and return the bytes of the
// regular-file entry named `name` (matching a bare name or a trailing /name).
// Skips pax/GNU long-name headers — our archives only hold short names (cctop,
// LICENSE), so a long-name entry is never the one we want.
export function extractFromTar(
  tar: Uint8Array,
  name: string,
): Uint8Array | null {
  const dec = new TextDecoder();
  let off = 0;
  while (off + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(off, off + TAR_BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const field = (start: number, len: number) =>
      dec
        .decode(header.subarray(start, start + len))
        .replace(/\0.*$/, "")
        .trim();
    const entry = field(0, 100);
    const size = Number.parseInt(field(124, 12), 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = off + TAR_BLOCK;
    if (
      (typeflag === "0" || typeflag === "\0") &&
      (entry === name || entry.endsWith(`/${name}`))
    )
      return tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

// --- Network + swap ------------------------------------------------------

async function latestVersion(): Promise<string> {
  // An explicit pin skips the network round-trip (also how the tests stay
  // offline): CCTOP_VERSION=v0.5.0 cctop upgrade.
  const pinned = process.env.CCTOP_VERSION?.trim();
  if (pinned) return pinned.startsWith("v") ? pinned : `v${pinned}`;
  const res = await fetch(`${RELEASES}/latest`, {
    redirect: "manual",
    headers: GITHUB_HEADERS,
  });
  const tag = tagFromLocation(res.headers.get("location"));
  if (!tag)
    throw new Error(`could not determine the latest release of ${REPO}`);
  return tag;
}

async function upgradeBinary(tag: string): Promise<void> {
  const asset = assetName();
  const base = `${RELEASES}/download/${tag}`;

  const sumsRes = await fetch(`${base}/cctop_checksums.txt`, {
    headers: GITHUB_HEADERS,
  });
  if (!sumsRes.ok)
    throw new Error(`fetching checksums: HTTP ${sumsRes.status}`);
  const want = parseChecksums(await sumsRes.text(), asset);
  if (!want) throw new Error(`no checksum published for ${asset}`);

  const tgzRes = await fetch(`${base}/${asset}`, { headers: GITHUB_HEADERS });
  if (!tgzRes.ok)
    throw new Error(`downloading ${asset}: HTTP ${tgzRes.status}`);
  const gz = new Uint8Array(await tgzRes.arrayBuffer());

  const got = new Bun.CryptoHasher("sha256").update(gz).digest("hex");
  if (got !== want)
    throw new Error(`checksum mismatch for ${asset} — refusing to install`);

  const bin = extractFromTar(Bun.gunzipSync(gz), "cctop");
  if (!bin || bin.length < MIN_BINARY_BYTES)
    throw new Error("the archive did not contain a valid cctop binary");

  // Replace ourselves atomically: write a sibling temp file on the *same*
  // filesystem, mark it executable, then rename over the running binary. The
  // rename only re-points the directory entry — the running process keeps its
  // open inode, so swapping a live executable is safe and the new version takes
  // effect on the next launch. Writing a *new* file (not the busy one) avoids
  // ETXTBSY. realpath() resolves a symlinked install so we replace the file,
  // not the link.
  const target = realpathSync(process.execPath);
  const tmp = `${target}.new-${process.pid}`;
  try {
    await Bun.write(tmp, bin);
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    const code = (e as { code?: string }).code;
    if (code === "EACCES" || code === "EPERM")
      throw new Error(
        `cannot write ${target} (permission denied) — re-run with the ` +
          `necessary permissions, or reinstall with install.sh`,
      );
    throw e;
  }
}

function printManualInstructions(latest: string): void {
  const installCmd = `  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`;
  if (Bun.main.includes("/.bun/install/global/")) {
    console.log(
      `This is a ${BOLD}bun install -g${RESET} install rather than the ` +
        `standalone binary, so it updates through bun:\n\n` +
        `  bun install -g github:${REPO}#${latest}\n\n` +
        `Or switch to the self-updating binary:\n\n${installCmd}`,
    );
    return;
  }
  console.log(
    `cctop is running from a source checkout, which self-update can't ` +
      `manage.\nUpdate it with git (\`git pull\`), or install the standalone ` +
      `binary:\n\n${installCmd}`,
  );
}

// --- Entry point ---------------------------------------------------------

export interface UpgradeOptions {
  check: boolean; // report the available version but don't install
}

// Returns the process exit code.
export async function runUpgrade(
  currentVersion: string,
  opts: UpgradeOptions,
): Promise<number> {
  let latest: string;
  try {
    assertValidOverrides();
    latest = await latestVersion();
  } catch (e) {
    console.error(
      `${RED}error:${RESET} could not check for updates — ${msg(e)}`,
    );
    return 1;
  }

  if (compareVersions(latest, currentVersion) <= 0) {
    console.log(`cctop is up to date (${BOLD}${currentVersion}${RESET}).`);
    return 0;
  }

  console.log(
    `New version available: ${DIM}${currentVersion}${RESET} → ` +
      `${BOLD}${GREEN}${latest}${RESET}`,
  );
  if (opts.check) {
    console.log(`Run ${BOLD}cctop upgrade${RESET} to install it.`);
    return 0;
  }

  // Only the standalone binary can swap itself; guide every other install.
  if (!isCompiledBinary()) {
    printManualInstructions(latest);
    return 0;
  }

  try {
    await upgradeBinary(latest);
  } catch (e) {
    console.error(`${RED}error:${RESET} upgrade failed — ${msg(e)}`);
    return 1;
  }
  // "restart cctop" would be the wrong instruction in the common case: nothing
  // is running, the user just typed `cctop upgrade`. A cctop that *is* running
  // elsewhere keeps executing its old inode and says so itself (the footer
  // notice in app.ts) — but a transient flash is easy to miss, so mention it.
  console.log(
    `${GREEN}✓${RESET} upgraded to ${BOLD}${latest}${RESET} — ` +
      `run ${BOLD}cctop${RESET} to use it.`,
  );
  console.log(
    `${DIM}Already-running instances keep the old version until restarted.${RESET}`,
  );
  return 0;
}
