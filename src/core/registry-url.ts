// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { toErrorMessage } from "./common";

/** Structural subset shared by config, providers, diagnostics, and output. */
export interface RegistryUrlDescriptor {
  url: string;
  name?: string;
}

export const REGISTRY_CREDENTIALS_UNSUPPORTED =
  "Registry URLs must not include username or password credentials. Authenticated registries are not supported by the built-in static-index or skills-sh providers; configure a credential-free HTTPS endpoint.";

const INVALID_REGISTRY_URL_LABEL = "(invalid registry URL)";
const HTTP_URL_TOKEN = /https?:\/\/[^\s<>"'`]+/giu;

/**
 * Detect URL userinfo without broadening this issue into general URL/network
 * validation (the SSRF/redirect boundary is tracked separately in #767).
 * The authority fallback catches malformed-but-obviously-credential-bearing
 * values that `URL` cannot parse so they cannot slip through the config gate.
 */
export function hasRegistryUrlCredentials(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    const authority = extractAuthority(raw);
    return authority?.includes("@") ?? false;
  }
}

/**
 * The only formatter for configured registry URLs. Credential-free valid URLs
 * retain their authored spelling; userinfo is removed structurally. Invalid
 * strings fail closed rather than being echoed into a diagnostic.
 */
export function formatRegistryUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return INVALID_REGISTRY_URL_LABEL;
    if (!parsed.username && !parsed.password) return raw;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    const authority = extractAuthority(raw);
    if (!authority) return INVALID_REGISTRY_URL_LABEL;
    const at = authority.lastIndexOf("@");
    if (at < 0) return INVALID_REGISTRY_URL_LABEL;
    const authorityStart = raw.indexOf(authority);
    if (authorityStart < 0) return INVALID_REGISTRY_URL_LABEL;
    return `${raw.slice(0, authorityStart)}${authority.slice(at + 1)}${raw.slice(authorityStart + authority.length)}`;
  }
}

/** A consistent human label built on the safe URL formatter. */
export function formatRegistryLabel(entry: RegistryUrlDescriptor): string {
  const url = formatRegistryUrl(entry.url);
  return entry.name ? `${entry.name} (${url})` : url;
}

/** Actionable fail-closed warning for runtime inputs that bypass config load. */
export function formatRegistryCredentialWarning(entry: RegistryUrlDescriptor): string {
  return `Registry ${formatRegistryLabel(entry)} was ignored. ${REGISTRY_CREDENTIALS_UNSUPPORTED}`;
}

/** Copy a registry entry for any structured-output boundary. */
export function registryEntryForOutput<T extends RegistryUrlDescriptor>(entry: T): T {
  return { ...entry, url: formatRegistryUrl(entry.url) };
}

/**
 * Remove userinfo from every HTTP(S) URL token in an untrusted error/warning
 * string while leaving ordinary credential-free query/path text untouched.
 */
export function redactCredentialBearingUrls(message: string): string {
  return message.replace(HTTP_URL_TOKEN, (candidate) =>
    hasRegistryUrlCredentials(candidate) ? formatRegistryUrl(candidate) : candidate,
  );
}

/** Fetch errors are untrusted: runtimes often include the request URL. */
export function formatRegistryError(error: unknown): string {
  return redactCredentialBearingUrls(toErrorMessage(error));
}

function extractAuthority(raw: string): string | undefined {
  const match = /^https?:\/\/([^/?#]*)/iu.exec(raw);
  return match?.[1];
}
