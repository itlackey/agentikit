// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The remaining `surfaces` advisory group for `akm health` (meta-review 08).
 * `stash-git-exposure` (08-F1) shipped first in ./stash-exposure.ts; this
 * module adds the other three read-only checks the adjudication approved:
 *
 *   - `secret-file-perms`   — env/secret/backup files not 0600, dirs not 0700 (F4)
 *   - `binary-config-skew`  — config.json written by a NEWER akm than this binary (F3)
 *   - `egress-endpoints`    — the remote-destination list, for eyeball diff (surfaces 3/9)
 *
 * Every collector is a pure projection over injected paths/config (no
 * process.env reads) and is silent when there is nothing to report, matching
 * the stash-exposure pattern. `egress-endpoints` is the one informational
 * (pass-status) entry: it emits whenever any remote endpoint is configured.
 */

import fs from "node:fs";
import path from "node:path";
import { MAX_CONFIG_FILE_BYTES, readTextFileWithLimit } from "../../core/common";
import { CURRENT_CONFIG_VERSION } from "../../core/config/config-schema";
import { compareConfigVersion } from "../../core/config/config-version";
import type { HealthCheckResult } from "./types";

/** POSIX permission checks are meaningless on Windows. */
type PlatformLike = NodeJS.Platform | string;

const GROUP_OTHER_BITS = 0o077;
const OFFENDER_EVIDENCE_CAP = 50;

function modeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

interface PermOffenderScan {
  /** Directories walked recursively; every entry within is checked. */
  roots: string[];
}

function checkPathMode(abs: string, offenders: string[], expectDirectory?: boolean): fs.Stats | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return undefined; // absent → nothing to protect
  }
  if ((stat.mode & GROUP_OTHER_BITS) === 0) return stat;
  const isDir = expectDirectory ?? stat.isDirectory();
  offenders.push(isDir ? `${abs}/ (${modeOctal(stat.mode)}, want 700)` : `${abs} (${modeOctal(stat.mode)}, want 600)`);
  return stat;
}

/**
 * `secret-file-perms` (08-F4): flag files that are not 0600 and directories
 * that are not 0700, anywhere akm stores credentials or captured content.
 *
 * Scans `env` and `secrets` under every configured bundle, plus
 * `<cache>/config-backups`. Silent when every path is tight (or absent).
 *
 * ── What this check is, and what it deliberately is NOT (#791) ──
 *
 * It flags files whose mode deviates from the mode **akm itself wrote them
 * with**. Env and secret assets and config backups are pinned to `0600` by
 * `writeFileAtomic` at the moment akm creates them, so finding one at `0644`
 * means something else changed it — that is real signal.
 *
 * It deliberately does NOT scan the managed databases or the per-run task logs.
 * A previous revision did (#756, alongside a chmod that has since been
 * reverted); with akm no longer setting those modes they are written at the
 * process umask, so `0644` is simply the correct default state on a typical
 * `022` machine. Flagging it would make `akm health` exit 4 on essentially
 * every single-user install — an alarm that fires always is not an alarm.
 * Protecting the data directory is the operator's call; umask and `chmod` are
 * their levers, and akm has no business either enforcing a mode there or
 * nagging about the default one.
 */
export function collectSecretPermsAdvisory(
  input: { stashDir: string; extraStashDirs?: readonly string[]; cacheDir: string },
  platform: PlatformLike = process.platform,
): HealthCheckResult | undefined {
  if (platform === "win32") return undefined;

  // Every CONFIGURED bundle, not only the primary one: a secondary bundle's
  // `env`/`secrets` hold exactly the same akm-written `0600` material, and an
  // operator running `akm health` has no reason to expect the check stops at
  // the default bundle.
  const stashDirs = [input.stashDir, ...(input.extraStashDirs ?? [])];
  const scan: PermOffenderScan = {
    roots: [
      ...stashDirs.flatMap((dir) => [path.join(dir, "env"), path.join(dir, "secrets")]),
      path.join(input.cacheDir, "config-backups"),
    ],
  };

  const offenders: string[] = [];

  for (const root of scan.roots) {
    if (checkPathMode(root, offenders, true) === undefined) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) checkPathMode(path.join(root, entry), offenders);
  }

  if (offenders.length === 0) return undefined;
  const preview = offenders.slice(0, 5).join("; ") + (offenders.length > 5 ? `; +${offenders.length - 5} more` : "");
  return {
    name: "secret-file-perms",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${offenders.length} env/secret/backup path(s) are readable by group/other: ${preview}. ` +
      "Tighten with chmod 600 (files) / chmod 700 (dirs) — these hold tokens, keys, and config snapshots, " +
      "and akm writes them 0600, so a looser mode means something else changed them.",
    evidence: { offenders: offenders.slice(0, OFFENDER_EVIDENCE_CAP) },
  };
}

/**
 * `binary-config-skew` (08-F3): warn when config.json carries a configVersion
 * NEWER than (or unorderable against) this binary's CURRENT_CONFIG_VERSION —
 * i.e. a newer/foreign akm wrote the shared config and this install is stale.
 * That is exactly the state where auto-migration is skipped (downgrade
 * protection) and the proven multi-install incident class begins. Silent for
 * same/older versions (auto-migration handles those) and unreadable configs
 * (config loading surfaces its own errors).
 */
export function collectConfigSkewAdvisory(configPath: string): HealthCheckResult | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
  const onDisk = raw.configVersion as string | number | undefined;
  const order = compareConfigVersion(onDisk, CURRENT_CONFIG_VERSION);
  const skewed = order === 1 || (onDisk !== undefined && order === undefined);
  if (!skewed) return undefined;
  return {
    name: "binary-config-skew",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `config.json has configVersion ${JSON.stringify(onDisk)} but this binary knows ${CURRENT_CONFIG_VERSION} — ` +
      "a newer akm wrote the shared config, so this install is stale and auto-migration is skipped " +
      "(downgrade protection). Upgrade this install; do not keep a stale binary against the shared config/DBs.",
    evidence: { onDiskConfigVersion: onDisk, binaryConfigVersion: CURRENT_CONFIG_VERSION },
  };
}

/**
 * Minimal structural view of the effective config for the egress list —
 * deliberately not the full AkmConfig type so tests stay decoupled and the
 * collector never needs config loading itself.
 */
export interface EgressConfigView {
  registries?: Array<{ url?: string; name?: string; enabled?: boolean }>;
  // 0.9.0 (spec §10.1): remote source URLs come from the `bundles` map's git /
  // website descriptors, not the retired `sources[]`.
  bundles?: Record<string, { path?: string; git?: string; website?: { url?: string }; npm?: string } | undefined>;
  engines?: Record<string, { kind?: string; endpoint?: string } | undefined>;
  embedding?: { endpoint?: string };
}

/**
 * `egress-endpoints` (08 surfaces 3/9): the full list of remote destinations
 * akm can talk to under the effective config — registries, remote sources,
 * LLM endpoints, embedding endpoint — as one pass-status informational entry
 * for eyeball diff against expectations. Silent only when nothing remote is
 * configured at all.
 */
export function collectEgressAdvisory(config: EgressConfigView | undefined): HealthCheckResult | undefined {
  if (!config) return undefined;
  const endpoints: string[] = [];

  for (const reg of config.registries ?? []) {
    if (reg.enabled === false || !reg.url) continue;
    endpoints.push(`registry ${reg.name ?? "(unnamed)"}: ${reg.url}`);
  }
  for (const [key, bundle] of Object.entries(config.bundles ?? {})) {
    if (!bundle) continue;
    const url = bundle.git ?? bundle.website?.url;
    if (!url) continue;
    endpoints.push(`source ${key} (${bundle.git ? "git" : "website"}): ${url}`);
  }
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine?.kind !== "llm" || !engine.endpoint) continue;
    endpoints.push(`llm ${name}: ${engine.endpoint}`);
  }
  if (config.embedding?.endpoint) endpoints.push(`embedding: ${config.embedding.endpoint}`);

  if (endpoints.length === 0) return undefined;
  return {
    name: "egress-endpoints",
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message:
      `${endpoints.length} remote endpoint(s) in the effective config (registries/sources/LLM/embedding) — ` +
      "review the evidence list for unexpected destinations.",
    evidence: { endpoints },
  };
}

/**
 * Aggregate the three collectors into the advisories array shape `akmHealth`
 * consumes. Order is fixed: perms → skew → egress.
 */
export function collectSurfacesAdvisories(input: {
  stashDir: string;
  /** Secondary configured bundle roots, scanned for `env/`/`secrets/` alongside the primary. */
  extraStashDirs?: readonly string[];
  cacheDir: string;
  configPath: string;
  config: EgressConfigView | undefined;
  platform?: PlatformLike;
}): HealthCheckResult[] {
  const results = [
    collectSecretPermsAdvisory(
      {
        stashDir: input.stashDir,
        ...(input.extraStashDirs ? { extraStashDirs: input.extraStashDirs } : {}),
        cacheDir: input.cacheDir,
      },
      input.platform ?? process.platform,
    ),
    collectConfigSkewAdvisory(input.configPath),
    collectEgressAdvisory(input.config),
  ];
  return results.filter((r): r is HealthCheckResult => r !== undefined);
}
