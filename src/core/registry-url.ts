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
const HTTP_URL_START = /https?:\/\//giu;

/**
 * Detect URL userinfo without broadening this issue into general URL/network
 * validation (the SSRF/redirect boundary is tracked separately in #767).
 * The authority fallback catches malformed-but-obviously-credential-bearing
 * values that `URL` cannot parse so they cannot slip through the config gate.
 */
export function hasRegistryUrlCredentials(raw: string): boolean {
  return registryUrlStartOffsets(raw).some((start) => hasCredentialsAtUrlStart(raw.slice(start)));
}

function hasCredentialsAtUrlStart(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    const authority = extractAuthority(raw);
    return authority ? authority.value.includes("@") : false;
  }
}

/**
 * The only formatter for configured registry URLs. Credential-free valid URLs
 * retain their authored spelling; userinfo is removed structurally. Invalid
 * strings fail closed rather than being echoed into a diagnostic.
 */
export function formatRegistryUrl(raw: string): string {
  let validHttpUrl = false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return INVALID_REGISTRY_URL_LABEL;
    validHttpUrl = true;
  } catch {
    // Invalid credential-bearing spellings still need a non-leaking fallback.
  }

  const formatted = redactUrlStartsRightToLeft(raw);
  if (validHttpUrl) return formatted;
  if (registryUrlStartOffsets(raw)[0] === 0 && formatted !== raw) return formatted;
  return INVALID_REGISTRY_URL_LABEL;
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
  let formatted = message;
  const starts = registryUrlStartOffsets(message);
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i];
    if (start === undefined) continue;
    const candidate = formatted.slice(start);
    if (!hasCredentialsAtUrlStart(candidate)) continue;
    formatted = `${formatted.slice(0, start)}${formatRegistryUrl(candidate)}`;
  }
  return formatted;
}

/** Fetch errors are untrusted: runtimes often include the request URL. */
export function formatRegistryError(error: unknown): string {
  return redactCredentialBearingUrls(toErrorMessage(error));
}

function redactUrlStartsRightToLeft(raw: string): string {
  let formatted = raw;
  const starts = registryUrlStartOffsets(raw);
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i];
    if (start === undefined) continue;
    const candidate = formatted.slice(start);
    if (!hasCredentialsAtUrlStart(candidate)) continue;
    const authority = extractAuthority(candidate);
    if (!authority) continue;
    const at = authority.value.lastIndexOf("@");
    if (at < 0) continue;
    const safeCandidate = `${candidate.slice(0, authority.start)}${authority.value.slice(at + 1)}${candidate.slice(authority.end)}`;
    formatted = `${formatted.slice(0, start)}${safeCandidate}`;
  }
  return formatted;
}

function registryUrlStartOffsets(raw: string): number[] {
  return Array.from(raw.matchAll(HTTP_URL_START), (match) => match.index);
}

function extractAuthority(raw: string): { value: string; start: number; end: number } | undefined {
  // WHATWG URL parsing tolerates/normalizes tabs, CR/LF, spaces, quotes,
  // backticks, and angle punctuation in userinfo. Only actual authority
  // delimiters end this scan; processing the last `@` removes all userinfo.
  const match = /^https?:\/\/([^\\/?#]*)/iu.exec(raw);
  if (!match) return undefined;
  const value = match[1];
  if (value === undefined) return undefined;
  const start = match[0].length - value.length;
  return { value, start, end: match[0].length };
}
