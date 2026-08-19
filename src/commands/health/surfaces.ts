// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The remaining `surfaces` advisory group for `akm health` (meta-review 08).
 * `stash-git-exposure` (08-F1) shipped first in ./stash-exposure.ts; this
 * module adds the other two read-only checks the adjudication approved:
 *
 *   - `binary-config-skew`  — config.json written by a NEWER akm than this binary (F3)
 *   - `egress-endpoints`    — the remote-destination list, for eyeball diff (surfaces 3/9)
 *
 * Every collector is a pure projection over injected paths/config (no
 * process.env reads) and is silent when there is nothing to report, matching
 * the stash-exposure pattern. `egress-endpoints` is the one informational
 * (pass-status) entry: it emits whenever any remote endpoint is configured.
 */

import { MAX_CONFIG_FILE_BYTES, readTextFileWithLimit } from "../../core/common";
import { CURRENT_CONFIG_VERSION } from "../../core/config/config-schema";
import { compareConfigVersion } from "../../core/config/config-version";
import { formatRegistryUrl } from "../../core/registry-url";
import type { HealthCheckResult } from "./types";

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
    endpoints.push(`registry ${reg.name ?? "(unnamed)"}: ${formatRegistryUrl(reg.url)}`);
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
 * Aggregate the two collectors into the advisories array shape `akmHealth`
 * consumes. Order is fixed: skew → egress.
 */
export function collectSurfacesAdvisories(input: {
  configPath: string;
  config: EgressConfigView | undefined;
}): HealthCheckResult[] {
  const results = [collectConfigSkewAdvisory(input.configPath), collectEgressAdvisory(input.config)];
  return results.filter((r): r is HealthCheckResult => r !== undefined);
}
